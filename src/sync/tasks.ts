import { HubClient } from "./hubClient";

/**
 * Symposium tasks are Sufficit-memory observations (task-anchor / task-checkpoint)
 * bound to a specific Symposium chat session via a tag. The session id is the
 * link: listing a session's tasks and removing them on session delete both key
 * off this marker.
 *
 * Deletion uses expiry (the hub mirrors the MCP, which has no hard delete): we
 * re-save each observation with an expiresAtUtc in the past so it drops out.
 */

export const SESSION_TAG_PREFIX = "symposium-session:";
export const sessionTag = (sessionId: string): string => SESSION_TAG_PREFIX + sessionId;

export interface TaskItem {
    id: string;
    type: string;
    title: string;
    summary: string;
    ts?: string;
    tags?: string;
}

const isTask = (type: unknown): boolean => String(type ?? "").startsWith("task");
const hasTag = (tags: unknown, tag: string): boolean => String(tags ?? "").split(",").map((t) => t.trim()).includes(tag);

/** Lists the task observations bound to a Symposium session (newest first). */
export async function fetchSessionTasks(hub: HubClient, sessionId: string): Promise<TaskItem[]> {
    if (!hub.configured() || !sessionId) { return []; }
    const tag = sessionTag(sessionId);
    // Tag search isn't guaranteed server-side, so pull recent tasks and filter
    // by the session tag locally.
    const recs = await hub.searchMemory({ limit: 100 });
    return (recs as any[])
        .filter((r) => isTask(r.type) && hasTag(r.tags, tag))
        .sort((a, b) => Date.parse(b.createdAtUtc || 0) - Date.parse(a.createdAtUtc || 0))
        .slice(0, 30)
        .map((r) => ({ id: r.id, type: r.type, title: r.title, summary: r.summary, ts: r.createdAtUtc, tags: r.tags }));
}

/** Expires (soft-deletes) every task observation bound to a session. Returns count. */
export async function expireSessionTasks(hub: HubClient, sessionId: string): Promise<number> {
    if (!hub.configured() || !sessionId) { return 0; }
    const tag = sessionTag(sessionId);
    const recs = await hub.searchMemory({ limit: 200 });
    const ids = (recs as any[]).filter((r) => isTask(r.type) && hasTag(r.tags, tag)).map((r) => String(r.id)).filter(Boolean);
    if (!ids.length) { return 0; }
    const full = await hub.getByIds(ids);
    const past = new Date(Date.now() - 1000).toISOString();
    let n = 0;
    for (const o of full as any[]) {
        try { await hub.save({ ...o, expiresAtUtc: past }); n++; } catch { /* best-effort */ }
    }
    return n;
}
