import * as fs from "fs";
import * as path from "path";
import type { ActionEnvelope, ChatState, Snapshot, URI } from "@microsoft/agent-host-protocol";
import { AHP_ROOT_URI, parseAhpUri } from "./channelUris";
import type { AhpHostRuntime, AhpRuntimeExport, AhpSessionHandle } from "./hostRuntime";

export const AHP_PROTOCOL_VERSION = "0.6.0";
export const AHP_SCHEMA_VERSION = 1;

interface PersistenceEnvelope {
    protocolVersion: string;
    schemaVersion: number;
    savedAt: string;
    runtime: AhpRuntimeExport;
}

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
            ? this.resnapshotOversizedSessions(exported)
            : exported;
        const state = redactRuntime(reSnapshotted);
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
            const trimmed = this.trimRetained(state);
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
        const file = this.file;
        const temporary = path.join(directory, `state.${process.pid}.tmp`);
        setImmediate(() => {
            const payload = this.writePending ?? serialized;
            this.writePending = undefined;
            fs.promises
                .mkdir(directory, { recursive: true, mode: 0o700 })
                .then(() =>
                    fs.promises.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 }),
                )
                .then(() => fs.promises.rename(temporary, file))
                .then(() => fs.promises.chmod(file, 0o600).catch(() => undefined))
                .catch(() => undefined)
                .finally(() => {
                    this.writeInFlight = false;
                    if (this.writePending !== undefined) {
                        this.scheduleWrite(this.writePending);
                    } else {
                        try {
                            fs.rmSync(temporary, { force: true });
                        } catch {
                            /* already removed by rename */
                        }
                    }
                });
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
        const temporary = path.join(this.directory, `state.${process.pid}.tmp`);
        if (payload !== undefined) {
            fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
            fs.renameSync(temporary, this.file);
            try {
                fs.chmodSync(this.file, 0o600);
            } catch {
                // Some remote filesystems do not expose POSIX mode changes.
            }
        }
        try {
            fs.rmSync(temporary, { force: true });
        } catch {
            /* already removed */
        }
    }

    /**
     * Re-snapshots any session whose owned snapshots exceed the per-session
     * cap, so validateRuntime does not throw on a long-running host. If a fresh
     * snapshot still exceeds the cap (because the live chat turn history itself
     * is too large), the oldest turns are trimmed from the persisted view until
     * it fits — the authoritative history is never lost, since it lives in the
     * JSON session repository and is re-loaded on each open. Returns the
     * runtime export with snapshots potentially replaced/trimmed. Complexity is
     * O(sessions * snapshots) plus a bounded turn-trim pass per oversized chat.
     */
    private resnapshotOversizedSessions(state: AhpRuntimeExport): AhpRuntimeExport {
        const snapshotFn = this.options.snapshotResources;
        if (!snapshotFn) return state;
        const snapshots = state.snapshots;
        const oversized = state.sessions.filter((handle) => {
            const owned = sessionOwnedSnapshots(snapshots, handle);
            return owned.length > 0 && byteLength(owned) > this.maxSessionBytes;
        });
        if (oversized.length === 0) return state;
        const replacements = new Map<URI, Snapshot>();
        let resnapshotCount = 0;
        let trimmedTurns = 0;
        for (const handle of oversized) {
            const ownedResources = sessionOwnedSnapshots(snapshots, handle).map((s) => s.resource);
            for (const snapshot of snapshotFn(ownedResources)) {
                // Clamp fromSeq to the exported serverSeq: the runtime may have
                // advanced between exportState() (tick N) and this deferred
                // serialization (tick N+1), which would make the fresh snapshot's
                // fromSeq exceed state.serverSeq and fail validation.
                const clamped =
                    snapshot.fromSeq > state.serverSeq
                        ? { ...snapshot, fromSeq: state.serverSeq }
                        : snapshot;
                replacements.set(clamped.resource, clamped);
                resnapshotCount++;
            }
            // If the fresh snapshot is still oversized (live state is large),
            // trim oldest chat turns until the session's owned bytes fit. Only
            // chat snapshots carry a `turns` array; others are left untouched.
            const ownedFresh = sessionOwnedSnapshots(
                snapshots.map((s) => replacements.get(s.resource) ?? s),
                handle,
            );
            if (byteLength(ownedFresh) <= this.maxSessionBytes) continue;
            const budget =
                this.maxSessionBytes -
                byteLength(
                    ownedFresh.filter(
                        (s) => !Array.isArray((s.state as { turns?: unknown }).turns),
                    ),
                );
            for (const snapshot of ownedFresh) {
                const chatState = snapshot.state as Partial<ChatState>;
                if (!Array.isArray(chatState.turns) || chatState.turns.length === 0) continue;
                let turns = [...chatState.turns];
                while (
                    turns.length > 1 &&
                    Buffer.byteLength(JSON.stringify(turns)) > Math.max(0, budget)
                ) {
                    turns = turns.slice(1);
                }
                if (turns.length < chatState.turns.length) {
                    trimmedTurns += chatState.turns.length - turns.length;
                    replacements.set(snapshot.resource, {
                        ...snapshot,
                        state: { ...chatState, turns } as ChatState,
                    });
                }
            }
        }
        if (replacements.size === 0) return state;
        const parts = [`re-snapshoted ${resnapshotCount} channel(s)`];
        if (trimmedTurns > 0) parts.push(`trimmed ${trimmedTurns} old turn(s)`);
        this.options.onDiagnostic?.(
            `[ahp] ${parts.join(", ")} across ${oversized.length} oversized session(s) before persisting`,
        );
        return {
            ...state,
            snapshots: snapshots.map((s) => replacements.get(s.resource) ?? s),
        };
    }

    /**
     * Trims the oldest retained actions until the serialized payload fits under
     * the total cap. Amortized O(retainedActions) via an average-bytes-per-action
     * estimate plus bounded refinement — never the O(n²) per-removal
     * re-serialization that previously pegged the extension host.
     */
    private trimRetained(state: AhpRuntimeExport): AhpRuntimeExport {
        const retainedActions = state.retainedActions;
        if (retainedActions.length <= 1) return state;

        // Measure the immutable base (everything except retained actions) once,
        // then trim retained actions by count rather than by re-serializing the
        // whole state per removal.
        const baseBytes = byteLength({ ...state, retainedActions: [] as ActionEnvelope[] });
        const retainedBytes = byteLength(retainedActions);
        if (baseBytes + retainedBytes <= this.maxBytes) return state;

        const avgPerAction = Math.max(1, Math.ceil(retainedBytes / retainedActions.length));
        const overage = baseBytes + retainedBytes - this.maxBytes;
        const estimatedRemovals = Math.min(
            retainedActions.length - 1,
            Math.ceil(overage / avgPerAction) + 1,
        );
        let trimmed = retainedActions.slice(estimatedRemovals);
        let iterations = 0;
        while (
            trimmed.length > 1 &&
            baseBytes + byteLength(trimmed) > this.maxBytes &&
            iterations++ < 32
        ) {
            trimmed = trimmed.slice(Math.max(1, Math.ceil(trimmed.length / 10)));
        }
        while (
            trimmed.length > 1 &&
            baseBytes + byteLength(trimmed) < this.maxBytes - avgPerAction &&
            iterations++ < 32
        ) {
            const reAdd = retainedActions.length - trimmed.length - 1;
            if (reAdd < 0) break;
            trimmed = retainedActions.slice(reAdd);
        }
        const removed = retainedActions.length - trimmed.length;
        if (removed <= 0) return state;
        const newFloor = trimmed[0]?.serverSeq ?? 0;
        this.options.onDiagnostic?.(
            `[ahp] trimmed ${removed} retained action(s) to stay under the ${this.maxBytes}-byte persistence cap (new floor serverSeq=${newFloor})`,
        );
        return { ...state, retainedActions: trimmed };
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

function validateEnvelope(value: unknown, maxSessionBytes: number): PersistenceEnvelope {
    if (!isRecord(value)) throw new Error("AHP persistence root is not an object");
    if (value.protocolVersion !== AHP_PROTOCOL_VERSION) {
        throw new Error(`Unsupported AHP protocol ${String(value.protocolVersion)}`);
    }
    if (value.schemaVersion !== AHP_SCHEMA_VERSION) {
        throw new Error(`Unsupported AHP persistence schema ${String(value.schemaVersion)}`);
    }
    const runtime = validateRuntime(value.runtime, maxSessionBytes);
    return {
        protocolVersion: AHP_PROTOCOL_VERSION,
        schemaVersion: AHP_SCHEMA_VERSION,
        savedAt: typeof value.savedAt === "string" ? value.savedAt : "",
        runtime,
    };
}

function validateRuntime(value: unknown, maxSessionBytes: number): AhpRuntimeExport {
    if (!isRecord(value)) throw new Error("AHP runtime state is not an object");
    const serverSeq = safeInteger(value.serverSeq, "serverSeq");
    const sessions = asArray<AhpSessionHandle>(value.sessions, "sessions");
    const snapshots = asArray<Snapshot>(value.snapshots, "snapshots");
    const retainedActions = asArray<ActionEnvelope>(value.retainedActions, "retainedActions");
    validateSnapshots(snapshots, serverSeq);
    validateActions(retainedActions, serverSeq);
    validateHandles(sessions, snapshots, maxSessionBytes);
    return { serverSeq, sessions, snapshots, retainedActions };
}

function validateSnapshots(snapshots: Snapshot[], serverSeq: number): void {
    const resources = new Set<string>();
    for (const snapshot of snapshots) {
        if (!snapshot || typeof snapshot.resource !== "string") {
            throw new Error("AHP snapshot has no resource");
        }
        if (resources.has(snapshot.resource)) throw new Error("Duplicate AHP snapshot resource");
        resources.add(snapshot.resource);
        if (snapshot.resource !== AHP_ROOT_URI) parseAhpUri(snapshot.resource);
        const fromSeq = safeInteger(snapshot.fromSeq, "snapshot.fromSeq");
        if (fromSeq > serverSeq) throw new Error("AHP snapshot sequence exceeds server sequence");
        if (!isRecord(snapshot.state)) throw new Error("AHP snapshot state is not an object");
    }
    if (!resources.has(AHP_ROOT_URI)) throw new Error("AHP root snapshot is missing");
}

function validateActions(actions: ActionEnvelope[], serverSeq: number): void {
    let previous = 0;
    for (const envelope of actions) {
        const sequence = safeInteger(envelope?.serverSeq, "action.serverSeq");
        if (sequence <= previous || sequence > serverSeq) {
            throw new Error("AHP retained actions are not strictly monotonic");
        }
        if (typeof envelope.channel !== "string") throw new Error("AHP action channel is missing");
        if (envelope.channel !== AHP_ROOT_URI) parseAhpUri(envelope.channel);
        if (!isRecord(envelope.action) || typeof envelope.action.type !== "string") {
            throw new Error("AHP action payload is invalid");
        }
        previous = sequence;
    }
}

function validateHandles(
    handles: AhpSessionHandle[],
    snapshots: Snapshot[],
    maxSessionBytes: number,
): void {
    const resources = new Set(snapshots.map((item) => item.resource));
    const seen = new Set<string>();
    for (const handle of handles) {
        if (
            !handle ||
            typeof handle.nativeSessionId !== "string" ||
            typeof handle.provider !== "string"
        ) {
            throw new Error("AHP session handle is invalid");
        }
        const session = parseAhpUri(handle.sessionResource);
        const chat = parseAhpUri(handle.chatResource);
        if (session.kind !== "session" || chat.kind !== "chat") {
            throw new Error("AHP session handle has cross-kind URIs");
        }
        if (session.id !== handle.sessionId || chat.id !== handle.chatId) {
            throw new Error("AHP session handle identity does not match its URIs");
        }
        if (seen.has(handle.sessionResource)) throw new Error("Duplicate AHP session handle");
        seen.add(handle.sessionResource);
        if (!resources.has(handle.sessionResource) || !resources.has(handle.chatResource)) {
            throw new Error("AHP session handle references missing snapshots");
        }
        const owned = sessionOwnedSnapshots(snapshots, handle);
        if (Buffer.byteLength(JSON.stringify(owned)) > maxSessionBytes) {
            throw new Error(`AHP session ${handle.sessionId} exceeds byte limit`);
        }
    }
}

/**
 * Snapshots owned by a session: its session channel, its chat channel, and any
 * descendant channel namespaced under the session resource. The same ownership
 * predicate powers both validation and auto-compaction.
 */
function sessionOwnedSnapshots(snapshots: Snapshot[], handle: AhpSessionHandle): Snapshot[] {
    return snapshots.filter(
        (item) =>
            item.resource === handle.sessionResource ||
            item.resource === handle.chatResource ||
            item.resource.startsWith(`${handle.sessionResource}/`),
    );
}

/** UTF-8 byte length of the JSON serialization of `value`. */
function byteLength(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value));
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

function asArray<T>(value: unknown, name: string): T[] {
    if (!Array.isArray(value)) throw new Error(`AHP ${name} is not an array`);
    return value as T[];
}

function safeInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`AHP ${name} is invalid`);
    }
    return value;
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
