import type { AgentSession, InjectionDropReason } from "../adapters/types";
import type { ChatQueue, PendingMessage } from "./controllerQueue";
import type { TurnTracker } from "./turn";

export interface SteerInjectionContext {
    queue: ChatQueue;
    emitQueue(): void;
    getSession?(): AgentSession | undefined;
    turns?: TurnTracker;
    createIntentId?(): string;
    emit?(message: unknown): void;
    log?(message: string): void;
}

/**
 * Attempts to splice a steer into the running turn. True means the adapter took
 * ownership: the caller must not queue it and must not emit a queue snapshot.
 */
export function tryInjectSteer(message: PendingMessage, ctx: SteerInjectionContext): boolean {
    const session = ctx.getSession?.();
    if (!session?.injectUserMessage || !ctx.turns?.current || !ctx.emit) {
        return false;
    }
    // Attachments need the outbound-prompt assembly only the dispatch path
    // builds (file contents folded into the text, vision split out), so they
    // fall back to the queue rather than losing their attachments here.
    if (message.attachments.length > 0) {
        return false;
    }
    const intentId = message.intentId ?? ctx.createIntentId?.() ?? "";
    message.intentId = intentId;
    return session.injectUserMessage({
        text: message.text,
        intentId: intentId || undefined,
        onCommitted: () => {
            ctx.emit?.({
                type: "user",
                text: message.text,
                attachments: message.attachments,
                clientMessageId: message.clientMessageId,
            });
            ctx.log?.(`[steer] injected into the running turn (intent ${intentId})`);
        },
        onDropped: (reason) => requeueDroppedSteer(message, reason, ctx),
    });
}

/**
 * The injection never reached the model, so it dispatches as its own turn.
 * Goes straight to the queue rather than back through routeControllerSend,
 * whose dedup already accepted this clientMessageId and would now reject it.
 */
export function requeueDroppedSteer(
    message: PendingMessage,
    reason: InjectionDropReason,
    ctx: SteerInjectionContext,
): void {
    if (reason === "cancelled" || reason === "superseded") {
        // Something newer deliberately took over; don't jump ahead of it.
        ctx.queue.enqueue(message);
    } else {
        ctx.queue.unshift(message);
    }
    ctx.emitQueue();
    ctx.log?.(`[steer] injection dropped (${reason}) — re-queued`);
}
