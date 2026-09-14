import { isArchivedStatus } from "./status";
import type { AhpHostRuntime } from "./hostRuntime";

/**
 * Aligns the archived bit of every projected AHP session with the user's
 * SessionStore truth. The projection learns about live sessions from
 * api.sessions.list, which carries no archive flag — without this sweep a
 * session archived on the desktop (or restored from an AHP snapshot) keeps
 * appearing in remote/PWA session lists. Idempotent: only differing flags
 * dispatch, so calling it on every sync is cheap and side-effect-free.
 */
export function reconcileArchivedSessions(
    runtime: AhpHostRuntime,
    archivedIds: ReadonlySet<string>,
): void {
    for (const summary of runtime.listSessions()) {
        const meta = (summary._meta?.symposium ?? {}) as { nativeSessionId?: unknown };
        const nativeId = typeof meta.nativeSessionId === "string" ? meta.nativeSessionId : "";
        if (!nativeId) continue;
        const handle = runtime.sessionByNative(summary.provider, nativeId);
        if (!handle) continue;
        if (isArchivedStatus(summary.status) === archivedIds.has(nativeId)) continue;
        runtime.dispatch(handle.sessionResource, {
            type: "session/isArchivedChanged",
            isArchived: archivedIds.has(nativeId),
        });
    }
}
