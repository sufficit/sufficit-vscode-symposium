import type { SessionInfo } from "../adapters/types";

/** SessionIndex surface consumed by the raw sessions source (kept narrow for tests). */
export interface SessionsSourceIndex {
    listCached(): SessionInfo[];
    reconcile(): Promise<SessionInfo[]>;
    /** First useful snapshot: resolves before every backend has landed. */
    ready(): Promise<SessionInfo[]>;
}

const RECONCILE_INTERVAL_MS = 5_000;

/**
 * Builds rawSessions() for the chat surface: warm starts return the cached
 * index snapshot immediately and schedule a throttled background reconcile;
 * a cold start returns the first useful snapshot (ready()) instead of
 * waiting for every backend to finish scanning.
 */
export function createSessionsSource(
    index: SessionsSourceIndex | undefined,
): () => Promise<SessionInfo[]> {
    let primed = (index?.listCached().length ?? 0) > 0;
    let lastReconcileAt = 0;
    return () => {
        if (!index) {
            return Promise.resolve([]);
        }
        const cached = index.listCached();
        if (primed) {
            if (Date.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
                lastReconcileAt = Date.now();
                void index.reconcile();
            }
            return Promise.resolve(cached);
        }
        lastReconcileAt = Date.now();
        // Cold start (issue #40): the first useful list must not wait for
        // every backend — ready() resolves as soon as one lands.
        void index.reconcile();
        return index.ready().then((sessions) => {
            primed = true;
            return sessions;
        });
    };
}
