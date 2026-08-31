import type { ActionEnvelope, Snapshot } from "@microsoft/agent-host-protocol";
import { AHP_ROOT_URI, parseAhpUri } from "./channelUris";
import type { AhpRuntimeExport, AhpSessionHandle } from "./hostRuntime";
import { AHP_FEATURE_VERSION } from "./feature";

/**
 * Structural validation for persisted AHP state, plus the byte accounting the
 * write path shares with it. Every helper is a pure function over the exported
 * runtime shape, so the same ownership and size predicates decide whether a
 * file loads and whether a save has to compact first.
 */

export const AHP_PROTOCOL_VERSION = AHP_FEATURE_VERSION;
export const AHP_SCHEMA_VERSION = 1;

export interface PersistenceEnvelope {
    protocolVersion: string;
    schemaVersion: number;
    savedAt: string;
    runtime: AhpRuntimeExport;
}

export function validateEnvelope(value: unknown, maxSessionBytes: number): PersistenceEnvelope {
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

export function validateRuntime(value: unknown, maxSessionBytes: number): AhpRuntimeExport {
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
export function sessionOwnedSnapshots(snapshots: Snapshot[], handle: AhpSessionHandle): Snapshot[] {
    return snapshots.filter(
        (item) =>
            item.resource === handle.sessionResource ||
            item.resource === handle.chatResource ||
            item.resource.startsWith(`${handle.sessionResource}/`),
    );
}

/** UTF-8 byte length of the JSON serialization of `value`. */
export function byteLength(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value));
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

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
