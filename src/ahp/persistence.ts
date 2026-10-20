import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../fileLock";
import type { AhpHostRuntime, AhpRuntimeExport } from "./hostRuntime";
import { mergeRuntimeExports } from "./persistenceMerge";
import { AhpStateCodec, type PreparedExport } from "./persistenceCodec";
import { parsePersistedJson } from "./jsonParseWorker";
import type { AhpPersistenceOptions } from "./persistenceTypes";
import { validateEnvelope } from "./persistenceValidation";

export { AHP_PROTOCOL_VERSION, AHP_SCHEMA_VERSION } from "./persistenceValidation";

export { type AhpPersistenceOptions } from "./persistenceTypes";

interface SaveRequest {
    exported: AhpRuntimeExport;
    resolve: () => void;
    reject: (error: unknown) => void;
}

interface CachedDiskState {
    mtimeMs: number;
    size: number;
    ino: number;
    runtime: AhpRuntimeExport;
}

const DEFAULT_SAVE_DEBOUNCE_MS = 150;

export class AhpPersistence {
    private readonly directory: string;
    private readonly file: string;
    private readonly maxBytes: number;
    private readonly maxSessionBytes: number;
    private readonly compactEveryActions: number;
    private readonly saveDebounceMs: number;
    private readonly autoCompact: boolean;
    private readonly codec: AhpStateCodec;
    private lastSavedSequence = 0;
    private lastScheduledSequence = 0;
    private pendingSaves: SaveRequest[] = [];
    /** Highest sequence still requiring a fresh capture after failure. */
    private retryPendingSequence: number | undefined;
    private drainPromise: Promise<void> | undefined;
    private drainTimer: NodeJS.Timeout | undefined;
    private cachedDiskState: CachedDiskState | undefined;

    constructor(
        root: string,
        private readonly options: AhpPersistenceOptions = {},
    ) {
        this.directory = path.join(root, "ahp");
        this.file = path.join(this.directory, "state.json");
        this.maxBytes = positive(options.maxBytes, 32 * 1024 * 1024);
        this.maxSessionBytes = positive(options.maxSessionBytes, 8 * 1024 * 1024);
        this.compactEveryActions = positive(options.compactEveryActions, 1_000);
        this.saveDebounceMs = nonNegative(options.saveDebounceMs, DEFAULT_SAVE_DEBOUNCE_MS);
        this.autoCompact = options.autoCompact ?? true;
        this.codec = new AhpStateCodec(
            this.maxBytes,
            this.maxSessionBytes,
            this.autoCompact,
            options,
        );
    }

    async load(): Promise<AhpRuntimeExport | undefined> {
        try {
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            return await withFileLock(this.file, async () => {
                try {
                    const contents = await fs.readFile(this.file);
                    if (contents.byteLength > this.maxBytes) {
                        throw new Error("AHP persistence exceeds total byte limit");
                    }
                    const parsed = await parsePersistedJson(contents);
                    await this.codec.warmEnvelope(parsed);
                    const envelope = validateEnvelope(parsed, this.maxSessionBytes, (owned) =>
                        this.codec.measureSnapshotArray(owned),
                    );
                    // Keep the validated cache byte-for-byte on load. Compaction is
                    // applied only on a subsequent save, after lossless session/turn
                    // structure and tool-call summaries have had priority.
                    const runtime = envelope.runtime;
                    this.lastSavedSequence = runtime.serverSeq;
                    this.lastScheduledSequence = runtime.serverSeq;
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

    /** Capture the latest immutable channel references, then coalesce one debounce window. */
    save(runtime: AhpHostRuntime): Promise<void> {
        const exported = runtime.exportState();
        this.lastScheduledSequence = Math.max(this.lastScheduledSequence, exported.serverSeq);
        const promise = new Promise<void>((resolve, reject) => {
            this.pendingSaves.push({ exported, resolve, reject });
        });
        this.startDrain();
        return promise;
    }

    private startDrain(force = false): void {
        if (this.drainPromise || this.drainTimer || !this.pendingSaves.length) return;
        if (!force && this.saveDebounceMs > 0) {
            this.drainTimer = setTimeout(() => {
                this.drainTimer = undefined;
                this.startDrain(true);
            }, this.saveDebounceMs);
            return;
        }
        this.drainPromise = this.drain()
            .catch((error) => {
                this.options.onDiagnostic?.(
                    `[ahp] drain failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            })
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
            let serialized: PreparedExport | undefined;
            let serializationError: unknown;
            while (candidateIndex >= 0) {
                try {
                    await this.codec.warm(batch[candidateIndex].exported);
                    serialized = this.codec.serialize(batch[candidateIndex].exported);
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
                this.lastScheduledSequence = Math.max(
                    this.lastSavedSequence,
                    this.pendingSaves[this.pendingSaves.length - 1]?.exported.serverSeq ?? 0,
                );
                continue;
            }

            try {
                await this.writePayload(serialized);
                const savedSequence = batch[candidateIndex].exported.serverSeq;
                this.lastSavedSequence = Math.max(this.lastSavedSequence, savedSequence);
                this.lastScheduledSequence = Math.max(
                    this.lastSavedSequence,
                    this.pendingSaves[this.pendingSaves.length - 1]?.exported.serverSeq ?? 0,
                );
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
                this.lastScheduledSequence = Math.max(
                    this.lastSavedSequence,
                    this.pendingSaves[this.pendingSaves.length - 1]?.exported.serverSeq ?? 0,
                );
            }
        }
    }

    /** Waits until all captured saves have either completed or failed. */
    async flush(): Promise<void> {
        while (this.drainPromise || this.drainTimer || this.pendingSaves.length) {
            if (this.drainTimer) {
                clearTimeout(this.drainTimer);
                this.drainTimer = undefined;
                this.startDrain(true);
            }
            if (this.drainPromise) await this.drainPromise;
            else if (this.pendingSaves.length) this.startDrain(true);
        }
    }

    async dispose(runtime?: AhpHostRuntime): Promise<void> {
        if (runtime) await this.save(runtime);
        await this.flush();
    }

    /** Serializes the cross-process read/merge/write transaction asynchronously. */
    private async writePayload(local: PreparedExport): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await withFileLock(this.file, async () => {
            const merged = await this.mergePersisted(local);
            const temporary = path.join(
                this.directory,
                `state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
            );
            try {
                await fs.writeFile(temporary, merged.payload, { encoding: "utf8", mode: 0o600 });
                await fs.rename(temporary, this.file);
                try {
                    await fs.chmod(this.file, 0o600);
                } catch {
                    // Some remote filesystems do not expose POSIX mode changes.
                }
                const stat = await fs.stat(this.file);
                this.cachedDiskState = {
                    mtimeMs: stat.mtimeMs,
                    size: stat.size,
                    ino: stat.ino,
                    runtime: merged.runtime,
                };
            } finally {
                await fs.rm(temporary, { force: true }).catch(() => undefined);
            }
        });
    }

    /**
     * Preserves sibling sessions. Valid-looking state that exceeds a cap, fails
     * validation or cannot merge is never silently overwritten with local data.
     */
    private async mergePersisted(local: PreparedExport): Promise<PreparedExport> {
        let persisted: AhpRuntimeExport;
        try {
            persisted = await this.readPersistedRuntime();
        } catch (error) {
            if (isMissingFile(error)) return local;
            // Truly unparseable bytes carry no sessions worth protecting: set them
            // aside for diagnosis. Anything else (size/session limits, schema,
            // I/O errors) is a valid-looking file we must not overwrite.
            if (error instanceof SyntaxError) {
                await this.quarantine(error);
                return local;
            }
            throw error;
        }
        const merged = mergeRuntimeExports(local.runtime, persisted);
        if (!merged.changed) return local;
        const prepared = this.codec.serialize(merged.runtime);
        this.options.onDiagnostic?.(
            `[ahp] merged ${merged.foreignSessions} session(s) from sibling Extension Host state`,
        );
        return prepared;
    }

    private async readPersistedRuntime(): Promise<AhpRuntimeExport> {
        const stat = await fs.stat(this.file);
        const cached = this.cachedDiskState;
        if (
            cached &&
            cached.size === stat.size &&
            cached.mtimeMs === stat.mtimeMs &&
            cached.ino === stat.ino
        ) {
            return cached.runtime;
        }
        if (stat.size > this.maxBytes)
            throw new Error("AHP shared state exceeds total byte limit; refusing overwrite");
        const contents = await fs.readFile(this.file);
        const parsed = await parsePersistedJson(contents);
        await this.codec.warmEnvelope(parsed);
        const envelope = validateEnvelope(parsed, this.maxSessionBytes, (owned) =>
            this.codec.measureSnapshotArray(owned),
        );
        this.cachedDiskState = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            ino: stat.ino,
            runtime: envelope.runtime,
        };
        return envelope.runtime;
    }

    maybeSave(runtime: AhpHostRuntime): boolean {
        if (
            this.retryPendingSequence === undefined &&
            runtime.store.serverSeq - Math.max(this.lastSavedSequence, this.lastScheduledSequence) <
                this.compactEveryActions
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

function nonNegative(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : fallback;
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
