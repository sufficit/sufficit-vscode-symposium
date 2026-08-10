import * as fs from "fs";
import * as path from "path";
import type { ActionEnvelope, Snapshot } from "@microsoft/agent-host-protocol";
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
    onDiagnostic?: (message: string) => void;
}

export class AhpPersistence {
    private readonly directory: string;
    private readonly file: string;
    private readonly maxBytes: number;
    private readonly maxSessionBytes: number;
    private readonly compactEveryActions: number;
    private lastSavedSequence = 0;

    constructor(
        root: string,
        private readonly options: AhpPersistenceOptions = {},
    ) {
        this.directory = path.join(root, "ahp");
        this.file = path.join(this.directory, "state.json");
        this.maxBytes = positive(options.maxBytes, 16 * 1024 * 1024);
        this.maxSessionBytes = positive(options.maxSessionBytes, 4 * 1024 * 1024);
        this.compactEveryActions = positive(options.compactEveryActions, 250);
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
        const state = redactRuntime(runtime.exportState());
        validateRuntime(state, this.maxSessionBytes);
        const envelope: PersistenceEnvelope = {
            protocolVersion: AHP_PROTOCOL_VERSION,
            schemaVersion: AHP_SCHEMA_VERSION,
            savedAt: new Date().toISOString(),
            runtime: state,
        };
        const serialized = JSON.stringify(envelope);
        if (Buffer.byteLength(serialized) > this.maxBytes) {
            throw new Error("AHP persistence exceeds total byte limit");
        }
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(this.directory, `state.${process.pid}.tmp`);
        try {
            fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
            fs.renameSync(temporary, this.file);
            try {
                fs.chmodSync(this.file, 0o600);
            } catch {
                // Some remote filesystems do not expose POSIX mode changes.
            }
            this.lastSavedSequence = state.serverSeq;
        } finally {
            try {
                fs.rmSync(temporary, { force: true });
            } catch {
                // Atomic rename already removed it in the normal path.
            }
        }
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
        const owned = snapshots.filter(
            (item) =>
                item.resource === handle.sessionResource ||
                item.resource === handle.chatResource ||
                item.resource.startsWith(`${handle.sessionResource}/`),
        );
        if (Buffer.byteLength(JSON.stringify(owned)) > maxSessionBytes) {
            throw new Error(`AHP session ${handle.sessionId} exceeds byte limit`);
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
