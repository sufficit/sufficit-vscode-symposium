import type { AgentSession } from "../adapters/types";
import type { ChatQueue, MessageDedup, PendingMessage, SendMode } from "./controllerQueue";
import { tryInjectSteer } from "./controllerSteerInjection";
import type { TurnTracker } from "./turn";

interface SendRouterContext {
    queue: ChatQueue;
    dedup: MessageDedup;
    busy: () => boolean;
    cancel: () => void;
    dispatch: (message: PendingMessage) => void;
    emitQueue: () => void;
    log?: (message: string) => void;
    /** Mid-turn steer injection; absent in tests and on backends without it. */
    getSession?: () => AgentSession | undefined;
    turns?: TurnTracker;
    createIntentId?: () => string;
    emit?: (message: unknown) => void;
}

export function routeControllerSend(
    message: PendingMessage,
    mode: SendMode,
    context: SendRouterContext,
): void {
    message.mode = mode;
    const preview = message.text.length > 40 ? `${message.text.slice(0, 40)}…` : message.text;
    if (!context.dedup.accept(message.clientMessageId)) {
        context.log?.(`[send] "${preview}" dropped — duplicate clientMessageId (already accepted)`);
        return;
    }
    if (mode === "redirect" && context.busy()) {
        if (/\b(stop|cancel|don'?t|never|pare|cancela|n[ãa]o)\b/i.test(message.text)) {
            context.queue.clear();
        }
        context.queue.unshift(message);
        context.cancel();
        context.emitQueue();
        context.log?.(`[send] "${preview}" — redirect while busy: queued at head, cancelling turn`);
        return;
    }
    if (mode === "steer" && context.busy()) {
        // Steer never interrupts. Backends that own their tool loop in-process
        // can splice it into the RUNNING turn at the next tool-safe boundary, so
        // the agent adapts immediately; it is then not a pending item at all.
        // Everything else — and a turn with no hop left — falls through to the
        // head of the queue and goes out at the turn boundary instead.
        if (tryInjectSteer(message, context)) {
            context.log?.(`[send] "${preview}" — steer while busy: injected into the running turn`);
            return;
        }
        context.queue.unshift(message);
        context.emitQueue();
        context.log?.(
            `[send] "${preview}" — steer while busy: queued at head (${context.queue.length} pending)`,
        );
        return;
    }
    if (context.busy()) {
        // Plain "queue": back of the line, after everything already pending.
        context.queue.enqueue(message);
        context.emitQueue();
        context.log?.(`[send] "${preview}" — busy: queued (${context.queue.length} pending)`);
        return;
    }
    if (!context.queue.isEmpty) {
        // Idle, but something is already waiting (typically a held queue left
        // over from a failed turn). Preserve FIFO instead of letting this
        // fresh send jump ahead of what's already queued: append it, then
        // dispatch the head. Sending is itself the explicit action that
        // releases a hold (dispatch() clears it), so this also resumes normal
        // draining from here.
        context.queue.enqueue(message);
        const head = context.queue.shift();
        if (head) {
            context.emitQueue();
            context.log?.(
                `[send] "${preview}" — idle but ${context.queue.length + 1} already queued: appended, dispatching head instead`,
            );
            context.dispatch(head);
        }
        return;
    }
    context.log?.(`[send] "${preview}" — idle, queue empty: dispatching directly`);
    context.dispatch(message);
}
