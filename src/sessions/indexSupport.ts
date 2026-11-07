import { AgentAdapter, SessionInfo } from "../adapters/types";
import { sessionKey, StoredSession } from "./repository";

/** A catalog mutation Symposium knows about (issue #40 phase 7). */
export interface InvalidateChange {
    backend?: string;
    path?: string;
    sessionId?: string;
}

/** Resolves cold-start waiters with the current snapshot so a surface never hangs. */
export function resolveColdWaiters(
    waiters: { resolve(sessions: SessionInfo[]): void }[],
    snapshot: () => SessionInfo[],
): void {
    for (const waiter of waiters.splice(0)) {
        waiter.resolve(snapshot());
    }
}

/** Replaces one provider's cached rows in place. */
export function applyProviderResult(
    sessions: Map<string, StoredSession>,
    backend: string,
    listed: readonly StoredSession[],
): void {
    for (const [key, session] of sessions) {
        if (session.backend === backend) {
            sessions.delete(key);
        }
    }
    for (const session of listed) {
        sessions.set(sessionKey({ backend, sessionId: session.sessionId }), session);
    }
}

/** Compact signature of a provider's rows, to detect effective catalog changes. */
export function providerSignature(
    sessions: ReadonlyMap<string, StoredSession>,
    backend: string,
): string {
    return JSON.stringify(
        [...sessions.values()]
            .filter((session) => session.backend === backend)
            .map((session) => [
                session.sessionId,
                session.title,
                session.updatedAt ?? null,
                session.parentId ?? null,
                session.lineageId ?? null,
            ])
            .sort(),
    );
}

/** Backends a targeted invalidation must rescan; empty means nothing to do. */
export function resolveInvalidateBackends(
    change: InvalidateChange,
    adapters: readonly AgentAdapter[],
    sessions: ReadonlyMap<string, StoredSession>,
): string[] {
    if (change.backend) {
        return adapters.some((adapter) => adapter.backend === change.backend)
            ? [change.backend]
            : [];
    }
    if (change.path) {
        const backends = new Set<string>();
        for (const session of sessions.values()) {
            if (session.transcriptPath === change.path) {
                backends.add(session.backend);
            }
        }
        return [...backends];
    }
    if (change.sessionId) {
        const owners = new Set<string>();
        for (const session of sessions.values()) {
            if (session.sessionId === change.sessionId) {
                owners.add(session.backend);
            }
        }
        if (owners.size === 1) {
            return [...owners];
        }
        // Unknown or ambiguous owner: rescan every adapter once; the
        // coalesced rescan keeps that fallback cheap.
        return adapters.map((adapter) => adapter.backend);
    }
    return [];
}
