import type { Snapshot } from "@microsoft/agent-host-protocol";
import type { AhpRuntimeExport } from "./hostRuntime";
import { AhpSerializationCache } from "./persistenceCache";
import { isRecord } from "./persistenceValidation";
import {
    type AhpCompactionLimits,
    compactHistoricalSnapshots,
    resnapshotOversizedSessions,
    trimRetained,
} from "./persistenceCompaction";
import {
    AHP_PROTOCOL_VERSION,
    AHP_SCHEMA_VERSION,
    type PersistenceEnvelope,
    validateRuntime,
} from "./persistenceValidation";
import type { AhpPersistenceOptions } from "./persistenceTypes";

export interface PreparedExport {
    runtime: AhpRuntimeExport;
    payload: string;
}

const TOOL_TEXT_CAPS = [1_024, 256];
const YIELD_EVERY_BYTES = 512 * 1024;

/** Serialization, size accounting and compaction policy for AHP state files. */
export class AhpStateCodec {
    private readonly serialized = new AhpSerializationCache();

    constructor(
        private readonly maxBytes: number,
        private readonly maxSessionBytes: number,
        private readonly autoCompact: boolean,
        private readonly options: AhpPersistenceOptions,
    ) {}

    /**
     * Serializes not-yet-cached channel states while yielding to the event loop
     * between channels, so a first save of a large cache never becomes one long
     * synchronous stringify. Later compaction/compose passes hit the cache.
     */
    async warm(exported: AhpRuntimeExport): Promise<void> {
        await this.warmSnapshots(exported.snapshots);
    }

    async warmEnvelope(value: unknown): Promise<void> {
        if (
            !isRecord(value) ||
            !isRecord(value.runtime) ||
            !Array.isArray(value.runtime.snapshots)
        ) {
            return;
        }
        await this.warmSnapshots(value.runtime.snapshots as AhpRuntimeExport["snapshots"]);
    }

    private async warmSnapshots(snapshots: AhpRuntimeExport["snapshots"]): Promise<void> {
        let sinceYield = 0;
        for (const snapshot of snapshots) {
            const state = snapshot.state as object;
            if (this.serialized.has(state)) continue;
            sinceYield += this.serialized.json(state).bytes;
            if (sinceYield >= YIELD_EVERY_BYTES) {
                sinceYield = 0;
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        }
    }

    serialize(exported: AhpRuntimeExport): PreparedExport {
        const targetBytes = this.autoCompact ? Math.floor(this.maxBytes * 0.25) : this.maxBytes;
        let lastError: unknown;
        let best: { runtime: AhpRuntimeExport; bytes: number } | undefined;
        const caps = this.autoCompact
            ? [Number.POSITIVE_INFINITY, ...TOOL_TEXT_CAPS]
            : [Number.POSITIVE_INFINITY];
        const tryCandidates = (base: AhpRuntimeExport): PreparedExport | undefined => {
            const trimmedBase = this.autoCompact
                ? trimRetained(base, { ...this.compactionLimits(), targetBytes })
                : base;
            let bestCandidate: { runtime: AhpRuntimeExport; bytes: number } | undefined;
            for (const cap of caps) {
                const candidate =
                    cap === Number.POSITIVE_INFINITY
                        ? trimmedBase
                        : this.capToolPayloads(trimmedBase, cap);
                try {
                    this.validate(candidate);
                    const bytes = this.measureEnvelope(candidate);
                    if (bytes <= this.maxBytes && (!bestCandidate || bytes < bestCandidate.bytes)) {
                        bestCandidate = { runtime: candidate, bytes };
                    }
                    if (bytes <= targetBytes) {
                        if (Number.isFinite(cap) && candidate !== trimmedBase) {
                            const shortened = this.serialized.lastCap !== cap;
                            this.serialized.lastCap = cap;
                            if (shortened) {
                                this.options.onDiagnostic?.(
                                    `[ahp] bounded oversized tool-call payload text at ${cap} characters in reconnect cache; all sessions and turns are retained, authoritative history is unchanged`,
                                );
                            }
                        }
                        return { runtime: candidate, payload: this.compose(candidate) };
                    }
                    lastError = new Error(
                        bytes > this.maxBytes
                            ? "AHP persistence exceeds total byte limit"
                            : "AHP persistence could not reach the compact-cache target",
                    );
                } catch (error) {
                    // A per-session byte limit may be satisfied by the next,
                    // smaller tool payload cap. Other validity failures surface
                    // after the lossless attempt and the bounded fallback.
                    lastError = error;
                }
            }
            if (!bestCandidate) return undefined;
            return { runtime: bestCandidate.runtime, payload: this.compose(bestCandidate.runtime) };
        };

        // First preserve every session and turn; only large tool-call payload
        // leaves are shortened, with an explicit marker and useful head/tail.
        let prepared = tryCandidates(exported);
        if (prepared && Buffer.byteLength(prepared.payload) <= targetBytes) return prepared;
        if (prepared)
            best = { runtime: prepared.runtime, bytes: this.measureEnvelope(prepared.runtime) };

        // Lossless text bounding could not fit the strict cap: now use the
        // established historical-turn compactor as a last-resort fallback.
        if (this.autoCompact && (!best || best.bytes > this.maxBytes)) {
            const compacted = compactHistoricalSnapshots(
                resnapshotOversizedSessions(exported, this.compactionLimits()),
                this.compactionLimits(),
            );
            prepared = tryCandidates(compacted);
            if (prepared) {
                const bytes = this.measureEnvelope(prepared.runtime);
                if (!best || bytes < best.bytes) best = { runtime: prepared.runtime, bytes };
            }
        }
        // A compact target is an optimization, never a reason to reject otherwise
        // valid history. Keep the smallest bounded cache under the hard ceiling.
        if (best && best.bytes <= this.maxBytes) {
            return { runtime: best.runtime, payload: this.compose(best.runtime) };
        }
        throw lastError ?? new Error("AHP persistence could not be serialized");
    }

    private capToolPayloads(runtime: AhpRuntimeExport, maxChars: number): AhpRuntimeExport {
        let changed = false;
        const snapshots = runtime.snapshots.map((snapshot) => {
            if (!snapshot.resource.startsWith("ahp-chat:/")) return snapshot;
            const state = this.serialized.cap(snapshot.state as object, maxChars);
            if (state === snapshot.state) return snapshot;
            changed = true;
            return { ...snapshot, state: state as typeof snapshot.state };
        });
        return changed ? { ...runtime, snapshots } : runtime;
    }

    private validate(runtime: AhpRuntimeExport): void {
        validateRuntime(runtime, this.maxSessionBytes, (owned) => this.measureSnapshotArray(owned));
    }

    private compose(runtime: AhpRuntimeExport): string {
        this.validate(runtime);
        const snapshots = runtime.snapshots.map((snapshot) => this.snapshotJson(snapshot));
        const sessions = this.json(runtime.sessions);
        const actions = this.json(runtime.retainedActions);
        const runtimeJson =
            `{"serverSeq":${runtime.serverSeq},"sessions":${sessions},"snapshots":[${snapshots.join(",")}]` +
            `,"retainedActions":${actions}}`;
        const envelope: PersistenceEnvelope = {
            protocolVersion: AHP_PROTOCOL_VERSION,
            schemaVersion: AHP_SCHEMA_VERSION,
            savedAt: new Date().toISOString(),
            runtime,
        };
        return (
            `{"protocolVersion":${JSON.stringify(envelope.protocolVersion)},"schemaVersion":${envelope.schemaVersion}` +
            `,"savedAt":${JSON.stringify(envelope.savedAt)},"runtime":${runtimeJson}}`
        );
    }

    private snapshotJson(snapshot: Snapshot): string {
        const state = this.serialized.json(snapshot.state as object).json;
        return `{"resource":${JSON.stringify(snapshot.resource)},"state":${state},"fromSeq":${snapshot.fromSeq}}`;
    }

    private json(value: object): string {
        return this.serialized.json(value).json;
    }

    measureSnapshotArray(snapshots: Snapshot[]): number {
        let total = 2 + Math.max(0, snapshots.length - 1);
        for (const snapshot of snapshots) total += Buffer.byteLength(this.snapshotJson(snapshot));
        return total;
    }

    private measureEnvelope(runtime: AhpRuntimeExport): number {
        const prefix =
            `{"protocolVersion":${JSON.stringify(AHP_PROTOCOL_VERSION)},"schemaVersion":${AHP_SCHEMA_VERSION}` +
            `,"savedAt":${JSON.stringify(new Date().toISOString())},"runtime":`;
        return Buffer.byteLength(prefix) + this.measureRuntime(runtime, true) + 1;
    }

    private measureRuntime(runtime: AhpRuntimeExport, includeActions: boolean): number {
        const sessions = this.json(runtime.sessions);
        const snapshots = this.measureSnapshotArray(runtime.snapshots);
        const actions = includeActions ? this.json(runtime.retainedActions) : "[]";
        return (
            Buffer.byteLength(
                `{"serverSeq":${runtime.serverSeq},"sessions":${sessions},"snapshots":[]` +
                    `,"retainedActions":${actions}}`,
            ) +
            snapshots -
            2
        );
    }

    /** Byte caps and collaborators handed to the compaction passes. */
    compactionLimits(): AhpCompactionLimits {
        return {
            maxBytes: this.maxBytes,
            maxSessionBytes: this.maxSessionBytes,
            targetBytes: this.autoCompact ? Math.floor(this.maxBytes * 0.25) : this.maxBytes,
            snapshotResources: this.options.snapshotResources,
            onDiagnostic: this.options.onDiagnostic,
            measureBytes: (value) => this.serialized.json(value).bytes,
            measureRuntime: (state, includeActions) => this.measureRuntime(state, includeActions),
        };
    }
}
