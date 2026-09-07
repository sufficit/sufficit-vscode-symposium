import type { Snapshot } from "@microsoft/agent-host-protocol";
import { AHP_ROOT_URI } from "./channelUris";
import type { AhpRuntimeExport } from "./hostRuntime";

export interface RuntimeMergeResult {
    runtime: AhpRuntimeExport;
    changed: boolean;
    foreignSessions: number;
}

/** Unions independently projected host state without losing ephemeral AHP ids. */
export function mergeRuntimeExports(
    local: AhpRuntimeExport,
    persisted: AhpRuntimeExport,
): RuntimeMergeResult {
    const localHandles = new Map(local.sessions.map((handle) => [handle.sessionResource, handle]));
    const persistedHandles = new Map(
        persisted.sessions.map((handle) => [handle.sessionResource, handle]),
    );
    const resources = new Set([...localHandles.keys(), ...persistedHandles.keys()]);
    const sessions: AhpRuntimeExport["sessions"] = [];
    const snapshots = new Map<string, Snapshot>();
    let changed = false;
    let foreignSessions = 0;

    for (const resource of resources) {
        const localHandle = localHandles.get(resource);
        const persistedHandle = persistedHandles.get(resource);
        let source = local;
        let handle = localHandle;
        if (!localHandle && persistedHandle) {
            source = persisted;
            handle = persistedHandle;
            changed = true;
            foreignSessions++;
        } else if (
            localHandle &&
            persistedHandle &&
            sessionFreshness(persisted, persistedHandle) > sessionFreshness(local, localHandle)
        ) {
            source = persisted;
            handle = persistedHandle;
            changed = true;
        }
        if (!handle) continue;
        sessions.push(handle);
        for (const snapshot of ownedSnapshots(source, handle)) {
            snapshots.set(snapshot.resource, snapshot);
        }
    }

    addUnownedSnapshots(snapshots, sessions, persisted.snapshots, local.snapshots);
    const serverSeq = Math.max(local.serverSeq, persisted.serverSeq);
    addRootSnapshot(snapshots, sessions.length, serverSeq, local, persisted);

    return {
        runtime: {
            serverSeq,
            sessions,
            snapshots: [...snapshots.values()],
            // Independent hosts allocate overlapping server sequences. Once a
            // foreign snapshot is merged, reconnect must fall back to snapshots.
            retainedActions: changed ? [] : local.retainedActions,
        },
        changed,
        foreignSessions,
    };
}

function addUnownedSnapshots(
    output: Map<string, Snapshot>,
    sessions: AhpRuntimeExport["sessions"],
    ...sources: Snapshot[][]
): void {
    for (const candidate of sources.flat()) {
        if (candidate.resource === AHP_ROOT_URI || belongsToAnySession(candidate, sessions)) {
            continue;
        }
        const current = output.get(candidate.resource);
        if (!current || candidate.fromSeq >= current.fromSeq) {
            output.set(candidate.resource, candidate);
        }
    }
}

function addRootSnapshot(
    output: Map<string, Snapshot>,
    activeSessions: number,
    serverSeq: number,
    local: AhpRuntimeExport,
    persisted: AhpRuntimeExport,
): void {
    const root =
        local.snapshots.find((item) => item.resource === AHP_ROOT_URI) ??
        persisted.snapshots.find((item) => item.resource === AHP_ROOT_URI);
    if (!root) return;
    output.set(AHP_ROOT_URI, {
        ...root,
        fromSeq: serverSeq,
        state: {
            ...(root.state as unknown as Record<string, unknown>),
            activeSessions,
        } as Snapshot["state"],
    });
}

function ownedSnapshots(
    runtime: AhpRuntimeExport,
    handle: AhpRuntimeExport["sessions"][number],
): Snapshot[] {
    return runtime.snapshots.filter(
        (snapshot) =>
            snapshot.resource === handle.sessionResource ||
            snapshot.resource === handle.chatResource ||
            snapshot.resource.startsWith(`${handle.sessionResource}/`),
    );
}

function belongsToAnySession(snapshot: Snapshot, sessions: AhpRuntimeExport["sessions"]): boolean {
    return sessions.some(
        (handle) =>
            snapshot.resource === handle.sessionResource ||
            snapshot.resource === handle.chatResource ||
            snapshot.resource.startsWith(`${handle.sessionResource}/`),
    );
}

function sessionFreshness(
    runtime: AhpRuntimeExport,
    handle: AhpRuntimeExport["sessions"][number],
): number {
    const chat = runtime.snapshots.find((item) => item.resource === handle.chatResource);
    const modifiedAt = (chat?.state as { modifiedAt?: unknown } | undefined)?.modifiedAt;
    const timestamp = typeof modifiedAt === "string" ? Date.parse(modifiedAt) : NaN;
    return Number.isFinite(timestamp) ? timestamp : (chat?.fromSeq ?? 0);
}
