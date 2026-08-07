import { HubClient, Observation } from "./hubClient";

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
/** Tag marking a task observation as completed (pending = absent). */
export const DONE_TAG = "status:done";

export interface TaskItem {
    id: string;
    type: string;
    title: string;
    summary: string;
    ts?: string;
    tags?: string;
    /** True when the task carries the DONE_TAG (completed). */
    done?: boolean;
}

/** Task-anchor: an executable work item the agent/user is meant to do. */
export const TASK_ANCHOR = "task-anchor";
/** Task-checkpoint: observed state (a fact/decision/result), NOT executable work. */
export const TASK_CHECKPOINT = "task-checkpoint";

const isTask = (type: unknown): boolean => String(type ?? "").startsWith("task");
/** A task-anchor: executable work (the only kind that counts as "pending work"). */
const isWorkItem = (type: unknown): boolean => String(type ?? "") === TASK_ANCHOR;
/** A task-checkpoint: observed historical state, never executable work. */
const isCheckpoint = (type: unknown): boolean => String(type ?? "") === TASK_CHECKPOINT;
const hasTag = (tags: unknown, tag: string): boolean =>
    String(tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .includes(tag);

/**
 * Recent-create cache, keyed by session: the hub's search index
 * (which fetchSessionTasks reads from) can lag well behind a save — a task
 * created moments ago may not be visible yet. Without this, task_complete's
 * "remaining" check reads a stale list missing that just-created sibling and
 * wrongly reports allTasksComplete while real work is still pending. Mirrors
 * surfaceSync.ts's ghost-task grace window, but protects the TOOL's own
 * signal to the model rather than just the task panel's display.
 * Entries stay until the search index observes them or they are explicitly
 * completed. A time limit is incorrect here: long-running plans can outlive it
 * while the index is still stale, producing a false allTasksComplete result.
 */
interface RecentTask {
    id: string;
    title: string;
    done: boolean;
}
const recentBySession = new Map<string, RecentTask[]>();

/** Records a just-created task so it survives a search-index lag window. */
export function rememberTaskCreated(sessionId: string, id: string, title: string): void {
    const list = recentBySession.get(sessionId) ?? [];
    list.push({ id, title, done: false });
    recentBySession.set(sessionId, list);
}

/** Marks a recently-created task done, so it stops padding "remaining". */
export function rememberTaskDone(sessionId: string, id: string): void {
    const entry = recentBySession.get(sessionId)?.find((t) => t.id === id);
    if (entry) {
        entry.done = true;
    }
}

/**
 * Sequential-batch tracking for task_complete's cascade: one add_task call
 * with N titles is documented as "in order" (a numbered plan, meant to be
 * done in sequence) — so completing task K implies 1..K-1 in that SAME batch
 * are also done, even if the agent forgot to call task_complete on them
 * individually. A LATER, separate add_task call is its own batch (not
 * assumed to continue the same sequence) — only ids created in one call
 * cascade together.
 */
const batchesBySession = new Map<string, string[][]>();

/** Records one add_task call's ids, in the order given, as a cascade batch. */
export function rememberTaskBatch(sessionId: string, ids: string[]): void {
    if (ids.length < 2) {
        return;
    } // nothing to cascade for a single-task batch
    const list = batchesBySession.get(sessionId) ?? [];
    list.push([...ids]);
    batchesBySession.set(sessionId, list);
}

/** Ids that precede `id` in its batch (if any), earliest first. */
export function priorInBatch(sessionId: string, id: string): string[] {
    const batches = batchesBySession.get(sessionId);
    if (!batches) {
        return [];
    }
    for (const batch of batches) {
        const idx = batch.indexOf(id);
        if (idx > 0) {
            return batch.slice(0, idx);
        }
        if (idx === 0) {
            return [];
        }
    }
    return [];
}

/**
 * Lists the task observations bound to a Symposium session (newest first).
 *
 * Returns BOTH task-anchor (executable work items) AND task-checkpoint
 * (observed historical state). This is the "display/state of the world" read:
 * the Tasks panel and the agent's list_tasks tool use it to show everything
 * bound to the session, including completed work and context checkpoints.
 *
 * Do NOT use this for "what should I do next" — a completed checkpoint must
 * never become the CURRENT pending task. Use {@link fetchPendingWorkItems}
 * for the intent path (prompt reminder + task_complete's next-step).
 */
export async function fetchSessionTasks(hub: HubClient, sessionId: string): Promise<TaskItem[]> {
    if (!hub.configured() || !sessionId) {
        return [];
    }
    // Search is scoped to the session by the native sessionId field on the
    // server; keep only task-type records for this session, newest first.
    const recs = await hub.searchMemory({ limit: 100, sessionId });
    const fromSearch = (
        recs as Array<{
            type: string;
            sessionId?: string;
            tags?: string | string[];
            id: unknown;
            title?: string;
            summary?: string;
            createdAtUtc?: string | number;
        }>
    )
        .filter((r) => isTask(r.type) && (r.sessionId ?? "") === sessionId)
        .sort(
            (a, b) =>
                Date.parse(String(b.createdAtUtc || "0")) -
                Date.parse(String(a.createdAtUtc || "0")),
        )
        .slice(0, 30)
        .map((r) => ({
            id: String(r.id),
            type: r.type,
            title: r.title ?? "",
            summary: r.summary ?? "",
            ts: String(r.createdAtUtc || ""),
            tags: Array.isArray(r.tags) ? r.tags.join(",") : (r.tags ?? ""),
            done: hasTag(r.tags, DONE_TAG),
        }));
    const knownIds = new Set(fromSearch.map((t) => t.id));
    const recent = recentBySession.get(sessionId) ?? [];
    const ghosts = recent
        .filter((t) => !knownIds.has(t.id))
        .filter((t) => !t.done)
        .map(
            (t): TaskItem => ({
                id: t.id,
                type: "task-anchor",
                title: t.title,
                summary: t.title,
                done: false,
            }),
        );
    // Once search observes an id, it is authoritative. Keep only unresolved
    // pending creates; completed entries and indexed entries no longer need the
    // local protection. This prevents stale ghosts without a time-based race.
    const unresolved = recent.filter((t) => !t.done && !knownIds.has(t.id));
    if (unresolved.length) {
        recentBySession.set(sessionId, unresolved);
    } else {
        recentBySession.delete(sessionId);
    }
    return [...fromSearch, ...ghosts];
}

/**
 * Pending executable work items for a session — ONLY task-anchor records that
 * are not yet done, newest first. This is the INTENT path: it feeds the prompt
 * reminder (so the CURRENT task is always real work, never a completed fact)
 * and task_complete's "next step" hand-back.
 *
 * A task-checkpoint (observed state) NEVER appears here, even when pending,
 * because observed state is not work to be done. This is the core separation
 * between "what I observed/did" and "what I should do".
 */
export async function fetchPendingWorkItems(
    hub: HubClient,
    sessionId: string,
): Promise<TaskItem[]> {
    const all = await fetchSessionTasks(hub, sessionId);
    return all.filter((t) => isWorkItem(t.type) && !t.done);
}

/**
 * Checkpoints (observed historical state) for a session, newest first — the
 * records that describe facts/decisions/results, NOT work to be done. This is
 * the read for resume context: the latest checkpoint anchors "where things
 * stand" without being confused with a pending task.
 */
export async function fetchSessionCheckpoints(
    hub: HubClient,
    sessionId: string,
): Promise<TaskItem[]> {
    const all = await fetchSessionTasks(hub, sessionId);
    return all.filter((t) => isCheckpoint(t.type));
}

/** Sets/clears a task's completed state (DONE_TAG). User- or agent-driven. */
export async function setTaskDone(
    hub: HubClient,
    id: string,
    done: boolean,
    completionSummary?: string,
): Promise<boolean> {
    if (!hub.configured() || !id) {
        return false;
    }
    // Direct upsert: save is id-based. Append or remove DONE_TAG without
    // spreading stale API fields back into the payload.
    try {
        const [obs] = await hub.getByIds([id]);
        const existing = obs ? String(obs.tags ?? "") : "";
        const tags = existing
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .filter((t) => t !== DONE_TAG);
        if (done) {
            tags.push(DONE_TAG);
        }
        const baseSummary = obs?.summary || "";
        const summary = completionSummary?.trim()
            ? baseSummary
                ? `${baseSummary}\n\nCompleted: ${completionSummary.trim()}`
                : `Completed: ${completionSummary.trim()}`
            : baseSummary;
        // Preserve the observation's existing type verbatim. The fallback only
        // applies when the record is missing its type: defaulting a task being
        // COMPLETED to task-anchor (executable work) rather than task-checkpoint
        // (observed state) — completing work must never silently reclassify it
        // into a historical-fact type, which would then disappear from pending
        // work and resurface only as resume context.
        const type = obs?.type || TASK_ANCHOR;
        await hub.save({ id, type, title: obs?.title || "task", summary, tags: tags.join(",") });
        return true;
    } catch {
        return false;
    }
}

/** Marks a task observation completed by adding the DONE_TAG (idempotent). */
export async function markTaskDone(
    hub: HubClient,
    id: string,
    completionSummary?: string,
): Promise<boolean> {
    // Delegate to setTaskDone which preserves existing tags (including the
    // critical symposium-session:xxx tag). A blind upsert with only DONE_TAG
    // wipes the session tag → fetchSessionTasks filter can never find the task
    // again → panel shows stale "pending" forever.
    return setTaskDone(hub, id, true, completionSummary);
}

/**
 * Latest task-checkpoint for a session (newest first), for resume context.
 *
 * Returns ONLY a real task-checkpoint — observed historical state that anchors
 * "where things stand". There is NO fallback to a task-anchor (executable work):
 * a pending work item must never be promoted to resume context, because that is
 * exactly the confusion between "what I observed/did" and "what I should do".
 * Returns undefined when the session has no checkpoint yet.
 */
export async function fetchLatestCheckpoint(
    hub: HubClient,
    sessionId: string,
): Promise<TaskItem | undefined> {
    const checkpoints = await fetchSessionCheckpoints(hub, sessionId);
    return checkpoints[0];
}

/** Expires (soft-deletes) every task observation bound to a session. Returns count. */
export async function expireSessionTasks(hub: HubClient, sessionId: string): Promise<number> {
    recentBySession.delete(sessionId);
    if (!hub.configured() || !sessionId) {
        return 0;
    }
    const recs = await hub.searchMemory({ limit: 200, sessionId });
    const ids = (recs as Array<{ type: string; sessionId?: string; id: unknown }>)
        .filter((r) => isTask(r.type) && (r.sessionId ?? "") === sessionId)
        .map((r) => String(r.id))
        .filter(Boolean);
    if (!ids.length) {
        return 0;
    }
    const full = await hub.getByIds(ids);
    const past = new Date(Date.now() - 1000).toISOString();
    let n = 0;
    for (const o of full as Array<Observation>) {
        try {
            await hub.save({ ...o, expiresAtUtc: past });
            n++;
        } catch {
            /* best-effort */
        }
    }
    return n;
}
