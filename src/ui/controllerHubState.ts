import { HubClient } from "../sync/hubClient";
import { fetchPendingWorkItems, TaskItem } from "../sync/tasks";
import { fetchSessionGuardrails } from "../sync/guardrails";

/** Mutable hub-state caches owned by the controller. */
export interface HubState {
    // User-defined guardrails: user rules injected on every outbound.
    guardrails: string[];
    guardrailsLoaded: boolean;
    // Pending WORK-ITEMS cache (task-anchor, not done): refreshed on every
    // dispatch to catch agent-created tasks. Checkpoints are excluded — they
    // are observed state, not work to do, so they never reach the prompt.
    pendingTasks: TaskItem[];
}

/**
 * Context bag for the hub-state helpers: per-session guardrails + pending
 * tasks, loaded lazily and refreshed on edit/dispatch. The reminder summary
 * feeds the outbound prompt.
 */
export interface HubStateContext {
    sessionId(): string | undefined;
    hub(): HubClient;
    state: HubState;
}

/**
 * (Re)loads the session's user guardrails into the per-message cache. Called on
 * EVERY dispatch (like tasks) so a guardrail added mid-conversation — by the
 * agent via add_guardrail, or by the user via the UI — is reflected on the next
 * outbound message, and so a transiently-empty first read (eventual indexing on
 * the memory hub) doesn't cache an empty list forever.
 */
export async function reloadGuardrails(ctx: HubStateContext): Promise<void> {
    const id = ctx.sessionId();
    if (!id || !ctx.hub().configured()) { ctx.state.guardrails = []; ctx.state.guardrailsLoaded = true; return; }
    try {
        ctx.state.guardrails = (await fetchSessionGuardrails(ctx.hub(), id)).map((g) => g.text).filter(Boolean);
        ctx.state.guardrailsLoaded = true;
    } catch { /* keep the prior cache; flag stays as-is so the next dispatch retries */ }
}

/**
 * (Re)loads pending WORK ITEMS and caches them for the prompt reminder.
 *
 * Loads ONLY task-anchor records that are not done — executable work the agent
 * should do. A task-checkpoint (observed historical state) is intentionally
 * excluded: a completed fact must never appear as the CURRENT pending task.
 * This is the intent path; the Tasks panel uses the full read separately.
 */
export async function reloadTasks(ctx: HubStateContext): Promise<void> {
    const id = ctx.sessionId();
    if (!id || !ctx.hub().configured()) { ctx.state.pendingTasks = []; return; }
    try {
        ctx.state.pendingTasks = await fetchPendingWorkItems(ctx.hub(), id);
    } catch { /* keep the prior cache */ }
}

/**
 * Builds a per-message reminder from pending WORK ITEMS, always naming the
 * CURRENT one explicitly (same idea as guardrails: injected on every dispatch
 * so the agent can't lose track mid-execution). "Current" is the first pending
 * task-anchor — real work to do, never a completed checkpoint that only
 * describes state. The Tasks panel may show checkpoints too (for context), but
 * they are excluded here so observed state can't masquerade as the next action.
 *
 * Authority: this reminder is CONTEXT, not an override. The pending work items
 * below are the agent's own tracked backlog, but they are explicitly subordinate
 * to the latest user message: if the user's current request redirects, narrows,
 * or cancels work ("stop", "don't do that now", "just verify", "only document",
 * "that's not what I meant", or a change of subject), CURRENT/Up next YIELD to
 * that request — the agent must not resume a stale backlog that the user has
 * since moved away from. Topic overlap with a listed task does not reactivate it.
 */
export function pendingTasksSummary(ctx: HubStateContext): string | undefined {
    if (ctx.state.pendingTasks.length === 0) { return undefined; }
    const isUserRequested = (t: TaskItem) => (t.tags ?? "").includes("creator:user");
    const fmt = (t: TaskItem) => (isUserRequested(t) ? `[USER] ${t.title}` : t.title);
    const [current, ...rest] = ctx.state.pendingTasks;
    const upNext = rest.map((t) => `- ${fmt(t)}`).join("\n");
    return (
        "[TASKS — current task marked below. This is CONTEXT, not an override: the LATEST USER MESSAGE is the " +
        "source of truth. If the user redirects, narrows, or cancels work (stop, don't do that now, just verify, " +
        "only document, change of subject), the tasks below YIELD to that request — do not resume a stale backlog " +
        "the user moved away from; topic overlap does not reactivate a task. " +
        "Call task_complete(id) IMMEDIATELY after finishing a task; the response hands you the next current task.]\n" +
        `→ CURRENT (id=${current.id}): ${fmt(current)}` +
        (rest.length ? `\nUp next:\n${upNext}` : "") +
        "\n(For [USER] tasks, present justification and WAIT for user confirmation before completing.)"
    );
}
