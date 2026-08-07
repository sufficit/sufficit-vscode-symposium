/** Pre-dispatch application orchestration. */
import { AgentAdapter, SessionStartOptions } from "../adapters/types";
import { nativeReasoning } from "../adapters/reasoning";
import { HubClient } from "../sync/hubClient";
import { fetchLatestCheckpoint } from "../sync/tasks";
import { PendingMessage } from "./controllerQueue";

/** Context bag for one turn's pre-dispatch setup (see ChatController.dispatch). */
export interface DispatchPrepContext {
    adapter: AgentAdapter;
    sessionId: string | undefined;
    hub: HubClient;
    /** Mutated in place with this turn's model/reasoning/permission/execDisplay/autonomy. */
    options: SessionStartOptions;
    reloadGuardrails(): Promise<void>;
    reloadTasks(): Promise<void>;
    getInjectedCheckpointId(): string | undefined;
    setInjectedCheckpointId(id: string): void;
}

/**
 * Pre-dispatch turn setup: refreshes guardrails/tasks so mid-conversation
 * additions reach the next outbound, prepends the latest session checkpoint on
 * a continuity message (deterministic resume hook, de-duped by id), and
 * applies this message's per-turn overrides onto the live session options.
 * Mutates `msg` and `ctx.options` in place. Extracted out of
 * `ChatController.dispatch()` (check:size) — same behavior, explicit `ctx`
 * instead of captured `this`.
 */
export async function prepareDispatch(
    ctx: DispatchPrepContext,
    msg: PendingMessage,
): Promise<void> {
    // Guardrails: refresh on EVERY dispatch (like tasks) so a guardrail
    // added mid-conversation (agent or UI) reaches the next outbound and a
    // transiently-empty first read doesn't cache empty forever. Injected on
    // every message below.
    if (ctx.adapter.roleAware?.() === true && ctx.sessionId && ctx.hub.configured()) {
        await ctx.reloadGuardrails();
    }
    // Tasks: refresh on EVERY dispatch to catch newly created tasks.
    if (ctx.sessionId && ctx.hub.configured()) {
        await ctx.reloadTasks();
    }
    // Resume hook (deterministic, no LLM): on a CONTINUITY message (idle or
    // queued, NOT steered), prepend this session's latest checkpoint so it
    // resumes from its own anchor. De-duped by id.
    if (
        msg.mode !== "steer" &&
        ctx.adapter.roleAware?.() === true &&
        ctx.sessionId &&
        ctx.hub.configured()
    ) {
        try {
            const cp = await fetchLatestCheckpoint(ctx.hub, ctx.sessionId);
            if (cp && cp.id !== ctx.getInjectedCheckpointId()) {
                msg.resumeCheckpoint = `[Resume — latest checkpoint for this session]\n${cp.title}\n${cp.summary}`;
                ctx.setInjectedCheckpointId(cp.id);
            }
        } catch {
            /* best-effort; resume still proceeds without it */
        }
    }
    // Apply per-message model/reasoning to the live options before (re)starting.
    // API backends read this per request; CLI changes take effect on the next
    // spawned turn and never alter a process that is already running.
    if (msg.model && msg.model !== "default" && msg.model !== "auto") {
        ctx.options.model = msg.model;
    }
    if (typeof msg.reasoning === "string") {
        const map = ctx.adapter.reasoningMap?.();
        ctx.options.reasoning = map ? nativeReasoning(map, msg.reasoning) : msg.reasoning;
    }
    if (msg.permission) {
        ctx.options.permission = msg.permission;
    }
    if (msg.execDisplay) {
        ctx.options.execDisplay = msg.execDisplay;
    }
    // Presence drives unbounded tool loops for API backends (autonomous mode).
    ctx.options.autonomy = msg.autonomy;
}
