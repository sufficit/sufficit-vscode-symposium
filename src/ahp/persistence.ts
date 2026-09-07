import * as fs from "fs";
import * as path from "path";
import type { Snapshot, URI } from "@microsoft/agent-host-protocol";
import { withFileLockSync } from "../fileLock";
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

    constructor(
        root: string,
        private readonly options: AhpPersistenceOptions = {},
    ) {
        this.directory = path.join(root, "ahp");
        this.file = path.join(this.directory, "state.json");
        this.maxBytes = positive(options.maxBytes, 32 * 1024 * 1024);
        this.maxSessionBytes = positive(options.maxSessionBytes, 8 * 1024 * 1024);
        this.compactEveryActions = positive(options.compactEveryActions, 250);
        this.autoCompact = options.autoCompact ?? true;
    }

    load(): AhpRuntimeExport | undefined {
        if (!fs.existsSync(this.file)) return undefined;
        try {
            const stat = fs.statSync(this.file);
            if (stat.size > this.maxBytes)
                throw new Error("AHP persistence exceeds total byte limit");
            const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
            const envelope = validateEnvelope(parsed, this.maxSessionBytes);
            this.lastSavedSequence = envelope.runtime.serverSeq;
            return envelope.runtime;
        } catch (error) {
            this.quarantine(error);
            return undefined;
        }
    }

    save(runtime: AhpHostRuntime): void {
        // Capture the exported state synchronously (it returns shallow copies of
        // the arrays, safe to process off-tick), then defer the expensive
        // serialization, validation and disk I/O to a later microtask so the
        // extension host stays responsive while a 10+ MB state.json is built.
        const exported = runtime.exportState();
        this.lastSavedSequence = exported.serverSeq;
        this.scheduleSerialize(exported);
    }

    /**
     * Synchronous save that serializes, validates and writes immediately on the
     * call stack. Used by tests that assert it throws on byte-limit violations
     * (the deferred {@link save} swallows those errors into diagnostics) and as
     * the flush primitive for {@link flushSync}.
     */
    saveSync(runtime: AhpHostRuntime): void {
        const exported = runtime.exportState();
        this.lastSavedSequence = exported.serverSeq;
        this.serializeAndWrite(exported);
    }

    private pendingExport: AhpRuntimeExport | undefined;
    private serializeInFlight = false;

    /**
     * Coalesces rapid save bursts (e.g. a history page loading many turns) into
     * a single deferred serialization+write. The whole pipeline — re-snapshot,
     * redact, validate, stringify, trim, write — runs off the call stack via
     * setImmediate, so the host keeps handling webview messages while it works.
     */
    private scheduleSerialize(exported: AhpRuntimeExport): void {
        this.pendingExport = exported;
        if (this.serializeInFlight) return;
        this.serializeInFlight = true;
        setImmediate(() => {
            const state = this.pendingExport;
            this.pendingExport = undefined;
            if (!state) {
                this.serializeInFlight = false;
                return;
            }
            try {
                this.serializeAndWrite(state);
            } catch (error) {
                this.options.onDiagnostic?.(
                    `[ahp] save failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            } finally {
                this.serializeInFlight = false;
                if (this.pendingExport !== undefined) {
                    this.scheduleSerialize(this.pendingExport);
                }
            }
        });
    }

    private serializeAndWrite(exported: AhpRuntimeExport): void {
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
            if (!this.autoCompact) {
                throw new Error("AHP persistence exceeds total byte limit");
            }
            const trimmed = trimRetained(state, this.compactionLimits());
            const trimmedEnvelope: PersistenceEnvelope = { ...envelope, runtime: trimmed };
            serialized = JSON.stringify(trimmedEnvelope);
            if (Buffer.byteLength(serialized) > this.maxBytes) {
                throw new Error("AHP persistence exceeds total byte limit");
            }
        }
        this.scheduleWrite(serialized);
    }

    private writePending: string | undefined;
    private writeInFlight = false;

    /**
     * Coalesces rapid save bursts (e.g. a history page loading many turns) into
     * a single disk write and runs the actual I/O off the call stack so the
     * extension host does not freeze while a large state.json is flushed.
     */
    private scheduleWrite(serialized: string): void {
        this.writePending = serialized;
        if (this.writeInFlight) return;
        this.writeInFlight = true;
        const directory = this.directory;
        setImmediate(() => {
            const payload = this.writePending ?? serialized;
            this.writePending = undefined;
            try {
                fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
                this.writePayload(payload);
            } catch (error) {
                this.options.onDiagnostic?.(
                    `[ahp] write failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            } finally {
                this.writeInFlight = false;
                if (this.writePending !== undefined) this.scheduleWrite(this.writePending);
            }
        });
    }

    /**
     * Synchronously drains any pending serialization and writes the current
     * state to disk. Used by tests and by dispose() to guarantee the file is
     * current before the process exits or an assertion reads it back.
     */
    flushSync(): void {
        // Drain any pending export that hasn't been serialized yet.
        if (this.pendingExport !== undefined) {
            const pending = this.pendingExport;
            this.pendingExport = undefined;
            this.serializeInFlight = false;
            try {
                this.serializeAndWrite(pending);
            } catch {
                /* best-effort flush */
            }
        }
        if (this.writePending === undefined && !this.writeInFlight) return;
        // Drain the pending payload synchronously.
        const payload = this.writePending;
        this.writePending = undefined;
        this.writeInFlight = false;
        if (payload !== undefined) {
            fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            this.writePayload(payload);
        }
    }

    /** Serializes the cross-process read/merge/write transaction. */
    private writePayload(localPayload: string): void {
        withFileLockSync(this.file, () => {
            const payload = this.mergePersisted(localPayload);
            const temporary = path.join(this.directory, `state.${process.pid}.${Date.now()}.tmp`);
            try {
                fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
                fs.renameSync(temporary, this.file);
                try {
                    fs.chmodSync(this.file, 0o600);
                } catch {
                    // Some remote filesystems do not expose POSIX mode changes.
                }
            } finally {
                try {
                    fs.rmSync(temporary, { force: true });
                } catch {
                    /* already renamed */
                }
            }
        });
    }

    /**
     * Preserves sessions projected by sibling code-server Extension Hosts.
     * Each browser owns an independent runtime, so replacing state.json with
     * only the local runtime loses ephemeral AHP ids and their chat snapshots.
     */
    private mergePersisted(localPayload: string): string {
        if (!fs.existsSync(this.file)) return localPayload;
        try {
            const local = validateEnvelope(JSON.parse(localPayload), this.maxSessionBytes);
            const persisted = validateEnvelope(
                JSON.parse(fs.readFileSync(this.file, "utf8")),
                this.maxSessionBytes,
            );
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
        if (runtime.store.serverSeq - this.lastSavedSequence < this.compactEveryActions) {
            return false;
        }
        this.save(runtime);
        return true;
    }

    private quarantine(error: unknown): void {
        const reason = error instanceof Error ? error.message : String(error);
        this.options.onDiagnostic?.(`AHP persistence ignored: ${reason}`);
        if (!fs.existsSync(this.file)) return;
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const suffix =
            reason.includes("schema") || reason.includes("protocol") ? "incompatible" : "corrupt";
        const target = path.join(this.directory, `state.${suffix}.${Date.now()}.json`);
        try {
            fs.renameSync(this.file, target);
        } catch (renameError) {
            this.options.onDiagnostic?.(
                `AHP persistence quarantine failed: ${
                    renameError instanceof Error ? renameError.message : String(renameError)
                }`,
            );
        }
    }
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
