import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Snapshot, URI } from "@microsoft/agent-host-protocol";
import { withFileLock } from "../fileLock";
import type { AhpHostRuntime, AhpRuntimeExport } from "./hostRuntime";
import { mergeRuntimeExports } from "./persistenceMerge";
import {
    type AhpCompactionLimits,
    compactHistoricalSnapshots,
    resnapshotOversizedSessions,
    trimRetained,
} from "./persistenceCompaction";
import {
    AHP_PROTOCOL_VERSION,
    AHP_SCHEMA_VERSION,
    isRecord,
    type PersistenceEnvelope,
    validateEnvelope,
    validateRuntime,
} from "./persistenceValidation";

export { AHP_PROTOCOL_VERSION, AHP_SCHEMA_VERSION } from "./persistenceValidation";

export interface AhpPersistenceOptions {
    maxBytes?: number;
    maxSessionBytes?: number;
    compactEveryActions?: number;
    /**
     * When true (default), {@link AhpPersistence.save} re-snapshots oversized
     * sessions via {@link snapshotResources} and trims old retained actions
     * before enforcing the byte caps, so a long-running session persists
     * instead of throwing. The throw remains a hard ceiling when even a fresh
     * single-session snapshot exceeds {@link maxSessionBytes}.
     */
    autoCompact?: boolean;
    /**
     * Returns a fresh snapshot reflecting the live channel state, used by
     * auto-compaction to collapse stale snapshots before persistence. When
     * omitted, auto-compaction cannot re-snapshot and falls back to trimming
     * retained actions only.
     */
    snapshotResources?: (resources: readonly URI[]) => Snapshot[];
    onDiagnostic?: (message: string) => void;
}

export class AhpPersistence {
    private readonly directory: string;
    private readonly file: string;
    private readonly maxBytes: number;
    private readonly maxSessionBytes: number;
    private readonly compactEveryActions: number;
    private readonly autoCompact: boolean;
    private lastSavedSequence = 0;
    /** Highest sequence that still needs to be captured after a failed save. */
    private retryPendingSequence: number | undefined;
    private pendingSaves: Array<{
        exported: AhpRuntimeExport;
        resolve: () => void;
        reject: (error: unknown) => void;
    }> = [];
    private drainPromise: Promise<void> | undefined;

    constructor(
        root: string,
        private readonly options: AhpPersistenceOptions = {},
    ) {
        this.directory = path.join(root, "ahp");
        this.file = path.join(this.directory, "state.json");
        this.maxBytes = positive(options.maxBytes, 32 * 1024 * 1024);
        this.maxSessionBytes = positive(options.maxSessionBytes, 8 * 1024 * 1024);
        this.compactEveryActions = positive(options.compactEveryActions, 1_000);
        this.autoCompact = options.autoCompact ?? true;
    }

    async load(): Promise<AhpRuntimeExport | undefined> {
        try {
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            return await withFileLock(this.file, async () => {
                try {
                    const contents = await fs.readFile(this.file, "utf8");
                    if (Buffer.byteLength(contents) > this.maxBytes) {
                        throw new Error("AHP persistence exceeds total byte limit");
                    }
                    const envelope = validateEnvelope(
                        JSON.parse(contents) as unknown,
                        this.maxSessionBytes,
                    );
                    const runtime = this.autoCompact
                        ? compactHistoricalSnapshots(envelope.runtime, this.compactionLimits())
                        : envelope.runtime;
                    this.lastSavedSequence = runtime.serverSeq;
                    return runtime;
                } catch (error) {
                    if (isMissingFile(error)) return undefined;
                    await this.quarantine(error);
                    return undefined;
                }
            });
        } catch (error) {
            this.options.onDiagnostic?.(
                `[ahp] load failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
        }
    }

    /** Captures a consistent snapshot now, then serializes and writes asynchronously. */
    save(runtime: AhpHostRuntime): Promise<void> {
        const exported = runtime.exportState();
        const promise = new Promise<void>((resolve, reject) => {
            this.pendingSaves.push({ exported, resolve, reject });
        });
        this.startDrain();
        return promise;
    }

    private startDrain(): void {
        if (this.drainPromise) return;
        this.drainPromise = new Promise<void>((resolve) => setImmediate(resolve))
            .then(() => this.drain())
            .finally(() => {
                this.drainPromise = undefined;
                if (this.pendingSaves.length) this.startDrain();
            });
    }

    private async drain(): Promise<void> {
        while (this.pendingSaves.length) {
            const batch = this.pendingSaves.splice(0);
            // Intermediate captures in the same burst are redundant: write the
            // newest complete runtime and resolve every waiter only afterwards.
            let candidateIndex = batch.length - 1;
            let serialized: string | undefined;
            let serializationError: unknown;
            while (candidateIndex >= 0) {
                try {
                    serialized = this.serialize(batch[candidateIndex].exported);
                    break;
                } catch (error) {
                    serializationError ??= error;
                    candidateIndex--;
                }
            }

            if (serialized === undefined) {
                this.retryPendingSequence = Math.max(
                    this.retryPendingSequence ?? 0,
                    batch[batch.length - 1].exported.serverSeq,
                );
                this.options.onDiagnostic?.(
                    `[ahp] save failed: ${serializationError instanceof Error ? serializationError.message : String(serializationError)}`,
                );
                for (const request of batch) request.reject(serializationError);
                continue;
            }

            try {
                await this.writePayload(serialized);
                const savedSequence = batch[candidateIndex].exported.serverSeq;
                this.lastSavedSequence = savedSequence;
                if (candidateIndex < batch.length - 1) {
                    this.retryPendingSequence = Math.max(
                        this.retryPendingSequence ?? 0,
                        batch[batch.length - 1].exported.serverSeq,
                    );
                } else if (
                    this.retryPendingSequence !== undefined &&
                    savedSequence >= this.retryPendingSequence
                ) {
                    this.retryPendingSequence = undefined;
                }
                for (let index = 0; index <= candidateIndex; index++) batch[index].resolve();
                for (let index = candidateIndex + 1; index < batch.length; index++) {
                    batch[index].reject(serializationError);
                }
                if (candidateIndex < batch.length - 1) {
                    this.options.onDiagnostic?.(
                        `[ahp] newest save capture skipped after serialization failure: ${serializationError instanceof Error ? serializationError.message : String(serializationError)}`,
                    );
                }
            } catch (error) {
                this.retryPendingSequence = Math.max(
                    this.retryPendingSequence ?? 0,
                    batch[batch.length - 1].exported.serverSeq,
                );
                this.options.onDiagnostic?.(
                    `[ahp] save failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                for (const request of batch) request.reject(error);
            }
        }
    }

    private serialize(exported: AhpRuntimeExport): string {
        const reSnapshotted = this.autoCompact
            ? resnapshotOversizedSessions(exported, this.compactionLimits())
            : exported;
        const compacted = this.autoCompact
            ? compactHistoricalSnapshots(reSnapshotted, this.compactionLimits())
            : reSnapshotted;
        const state = redactRuntime(compacted);
        validateRuntime(state, this.maxSessionBytes);
        const envelope: PersistenceEnvelope = {
            protocolVersion: AHP_PROTOCOL_VERSION,
            schemaVersion: AHP_SCHEMA_VERSION,
            savedAt: new Date().toISOString(),
            runtime: state,
        };
        let serialized = JSON.stringify(envelope);
        if (Buffer.byteLength(serialized) > this.maxBytes) {
            if (!this.autoCompact) throw new Error("AHP persistence exceeds total byte limit");
            const trimmed = trimRetained(state, this.compactionLimits());
            serialized = JSON.stringify({ ...envelope, runtime: trimmed });
            if (Buffer.byteLength(serialized) > this.maxBytes) {
                throw new Error("AHP persistence exceeds total byte limit");
            }
        }
        return serialized;
    }

    /** Waits until all captured saves have either completed or failed. */
    async flush(): Promise<void> {
        while (this.drainPromise || this.pendingSaves.length) {
            if (this.drainPromise) await this.drainPromise;
            else this.startDrain();
        }
    }

    async dispose(runtime?: AhpHostRuntime): Promise<void> {
        if (runtime) await this.save(runtime);
        await this.flush();
    }

    /** Serializes the cross-process read/merge/write transaction asynchronously. */
    private async writePayload(localPayload: string): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await withFileLock(this.file, async () => {
            const payload = await this.mergePersisted(localPayload);
            const temporary = path.join(
                this.directory,
                `state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
            );
            try {
                await fs.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
                await fs.rename(temporary, this.file);
                try {
                    await fs.chmod(this.file, 0o600);
                } catch {
                    // Some remote filesystems do not expose POSIX mode changes.
                }
            } finally {
                await fs.rm(temporary, { force: true }).catch(() => undefined);
            }
        });
    }

    /** Preserves sessions projected by sibling code-server Extension Hosts. */
    private async mergePersisted(localPayload: string): Promise<string> {
        let persistedContents: string;
        try {
            persistedContents = await fs.readFile(this.file, "utf8");
        } catch (error) {
            if (isMissingFile(error)) return localPayload;
            throw error;
        }
        try {
            const local = validateEnvelope(JSON.parse(localPayload), this.maxSessionBytes);
            const persisted = validateEnvelope(JSON.parse(persistedContents), this.maxSessionBytes);
            const merged = mergeRuntimeExports(local.runtime, persisted.runtime);
            if (!merged.changed) return localPayload;
            let runtime = compactHistoricalSnapshots(merged.runtime, this.compactionLimits());
            validateRuntime(runtime, this.maxSessionBytes);
            let envelope: PersistenceEnvelope = {
                ...local,
                savedAt: new Date().toISOString(),
                runtime,
            };
            let serialized = JSON.stringify(envelope);
            if (Buffer.byteLength(serialized) > this.maxBytes) {
                runtime = trimRetained(runtime, this.compactionLimits());
                envelope = { ...envelope, runtime };
                serialized = JSON.stringify(envelope);
            }
            if (Buffer.byteLength(serialized) > this.maxBytes) {
                throw new Error("AHP merged persistence exceeds total byte limit");
            }
            this.options.onDiagnostic?.(
                `[ahp] merged ${merged.foreignSessions} session(s) from sibling Extension Host state`,
            );
            return serialized;
        } catch (error) {
            this.options.onDiagnostic?.(
                `[ahp] shared-state merge skipped: ${error instanceof Error ? error.message : String(error)}`,
            );
            return localPayload;
        }
    }

    /** Byte caps and collaborators handed to the compaction passes. */
    private compactionLimits(): AhpCompactionLimits {
        return {
            maxBytes: this.maxBytes,
            maxSessionBytes: this.maxSessionBytes,
            snapshotResources: this.options.snapshotResources,
            onDiagnostic: this.options.onDiagnostic,
        };
    }

    maybeSave(runtime: AhpHostRuntime): boolean {
        if (
            this.retryPendingSequence === undefined &&
            runtime.store.serverSeq - this.lastSavedSequence < this.compactEveryActions
        ) {
            return false;
        }
        void this.save(runtime).catch(() => undefined);
        return true;
    }

    private async quarantine(error: unknown): Promise<void> {
        const reason = error instanceof Error ? error.message : String(error);
        this.options.onDiagnostic?.(`[ahp] persistence ignored: ${reason}`);
        const suffix =
            reason.includes("schema") || reason.includes("protocol") ? "incompatible" : "corrupt";
        const target = path.join(this.directory, `state.${suffix}.${Date.now()}.json`);
        try {
            await fs.rename(this.file, target);
        } catch (renameError) {
            if (!isMissingFile(renameError)) {
                this.options.onDiagnostic?.(
                    `[ahp] persistence quarantine failed: ${renameError instanceof Error ? renameError.message : String(renameError)}`,
                );
            }
        }
    }
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function redactRuntime(runtime: AhpRuntimeExport): AhpRuntimeExport {
    return redact(runtime) as AhpRuntimeExport;
}

function redact(value: unknown, key = ""): unknown {
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (!isRecord(value)) return value;
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        if (isProtectedKey(childKey) || (key === "_meta" && childKey.startsWith("private"))) {
            continue;
        }
        output[childKey] = redact(childValue, childKey);
    }
    return output;
}

function isProtectedKey(key: string): boolean {
    return /^(authorization|cookie|credential|credentials|env|environment|secret|token)$/i.test(
        key,
    );
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
