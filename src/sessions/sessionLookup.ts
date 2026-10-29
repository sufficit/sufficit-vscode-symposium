import type { SessionInfo } from "../adapters/types";
import type { LiveSessions } from "./runtime";
import type { SessionStore } from "./store";

/** Collaborators needed to resolve one session's metadata without a scan. */
export interface SessionLookupDeps {
    runtime: Pick<LiveSessions, "liveInfos" | "statusFor">;
    store: Pick<SessionStore, "decorate">;
    /** Cached SessionIndex lookup, when an index is available. */
    indexGet?: (backend: string, sessionId: string) => SessionInfo | undefined;
}

/**
 * Builds a synchronous (backend, sessionId) resolver for last-session restore:
 * live runtime first (freshest, pre-index), then the cached index snapshot
 * decorated with user metadata (custom title, archived/pinned, lineage).
 * Returns undefined when neither knows the session — never falls back to a
 * listSessions() scan of every backend.
 */
export function createSessionLookup(
    deps: SessionLookupDeps,
): (backend: string, sessionId: string) => SessionInfo | undefined {
    return (backend, sessionId) => {
        const live = deps.runtime
            .liveInfos()
            .find((info) => info.backend === backend && info.sessionId === sessionId);
        if (live) {
            // decorate applies user metadata (custom title, archived/pinned,
            // lineage) exactly like the indexed branch, while filtering ids
            // that were permanently deleted from the store.
            const [decorated] = deps.store.decorate([live], true);
            if (!decorated) {
                return undefined;
            }
            return { ...decorated, updatedAt: new Date() };
        }
        const indexed = deps.indexGet?.(backend, sessionId);
        if (!indexed) {
            return undefined;
        }
        // decorate applies custom title/archived/pinned/lineage and drops
        // permanently deleted ids; showArchived mirrors listSessions so an
        // archived last session still restores.
        const [decorated] = deps.store.decorate([indexed], true);
        if (!decorated) {
            return undefined;
        }
        return {
            ...decorated,
            status: deps.runtime.statusFor(sessionId) ?? decorated.terminalStatus,
        };
    };
}
