/** Outbound prompt assembly for one application turn. */
import { AgentAdapter, SessionStartOptions } from "../adapters/types";
import { rtkCached } from "../adapters/rtk";
import {
    buildOutboundPrompt,
    OutboundPromptState,
    responseLanguageName,
    TrackingMode,
} from "./outboundPrompt";
import { PendingMessage } from "./controllerQueue";
import type { ConfigurationPort } from "./ports";

/** Context bag for building one turn's outbound prompt (see ChatController.dispatch). */
export interface DispatchPromptContext {
    adapter: AgentAdapter;
    sessionId: string | undefined;
    options: Pick<SessionStartOptions, "seedHistory" | "bootstrap" | "handoff">;
    hubState: { guardrails: string[] };
    aiToolsInfo(): { available: string[]; enabled: string[] } | undefined;
    pendingTasksSummary(): string | undefined;
    /** One-shot injection flags, mutated in place with the post-build state. */
    promptState: OutboundPromptState;
    configuration: ConfigurationPort;
}

/**
 * Splits attachments (vision-capable backends inline images instead of
 * attaching them), resolves this turn's tracking mode, and composes the
 * outbound prompt with its one-shot policy/context preambles. Extracted out of
 * `ChatController.dispatch()` (check:size) — same behavior, explicit `ctx`
 * instead of captured `this`.
 */
export function buildDispatchOutbound(
    ctx: DispatchPromptContext,
    msg: PendingMessage,
): { text: string; preamble: string[]; trackingMode: TrackingMode; images: string[] } {
    // Images are inlined as vision blocks when the backend supports it.
    const isImage = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);
    const canVision = ctx.adapter.supportsImages?.() === true;
    const images = canVision ? msg.attachments.filter(isImage) : [];
    const fileAtts = canVision ? msg.attachments.filter((p) => !isImage(p)) : msg.attachments;

    // Role-aware backends (HTTP API) carry one-shot app instructions as
    // `developer` messages; CLIs get them prepended to the user text.
    const roleAware = ctx.adapter.roleAware?.() === true;
    // Plan/tracking discipline is injected on EVERY backend so the agent
    // always plans up front and keeps the next step visible. The mode
    // matches the backend's tracking capability: native todo tool (CLIs),
    // Symposium session task tools (OpenAI w/ Hub), or a ```todo fence.
    const hasHubTaskTools = (ctx.aiToolsInfo()?.available ?? []).includes("add_task");
    const trackingMode: TrackingMode =
        ctx.adapter.hasNativeTodo?.() === true ? "native" : hasHubTaskTools ? "hub-tools" : "fence";

    const outbound = buildOutboundPrompt({
        text: msg.text,
        fileAttachments: fileAtts,
        ...ctx.promptState,
        sessionId: ctx.sessionId,
        rtk: rtkCached(),
        speechEnabled:
            ctx.configuration.get("symposium", "voice.continuous", false) ||
            ctx.configuration.get("symposium", "voice.interimResults", false),
        // Checkpoint (context-window) discipline only where it's needed:
        // a context-windowing backend (roleAware/native) that has the
        // Sufficit memory tool. Tracking discipline is separate (below).
        checkpoints: roleAware && (ctx.aiToolsInfo()?.available ?? []).includes("memory_save"),
        trackingMode,
        // Fence mode only: a hub-tools session (OpenAI w/ Hub) must not
        // ALSO get the raw ```todo fence instruction — it already got
        // planTrackingPreamble("hub-tools") above, and getting both would
        // tell the model to track the same plan two different ways.
        todoInjection: trackingMode === "fence" ? ctx.adapter.todoInjection?.() : undefined,
        seedHistory: ctx.options.seedHistory,
        handoff: ctx.options.handoff,
        bootstrap: ctx.options.bootstrap,
        resumeCheckpoint: msg.resumeCheckpoint,
        interruptedBy: msg.interruptedBy,
        guardrails: ctx.hubState.guardrails,
        pendingTasksSummary: ctx.pendingTasksSummary(),
        autonomy: msg.autonomy,
        responseLanguage: responseLanguageName(
            ctx.configuration.get("symposium.chat", "preferredLanguage", "").trim() ||
                ctx.configuration.language ||
                "en",
        ),
        asRoles: roleAware,
    });
    Object.assign(ctx.promptState, outbound.state);
    return { text: outbound.text, preamble: outbound.preamble, trackingMode, images };
}
