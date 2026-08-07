import type { ChatQueue, MessageDedup, PendingMessage, SendMode } from "./controllerQueue";

interface SendRouterContext {
    queue: ChatQueue;
    dedup: MessageDedup;
    busy: () => boolean;
    cancel: () => void;
    dispatch: (message: PendingMessage) => void;
    emitQueue: () => void;
}

export function routeControllerSend(
    message: PendingMessage,
    mode: SendMode,
    context: SendRouterContext,
): void {
    message.mode = mode;
    if (!context.dedup.accept(message.clientMessageId)) return;
    if (mode === "redirect" && context.busy()) {
        if (/\b(stop|cancel|don'?t|never|pare|cancela|n[ãa]o)\b/i.test(message.text)) {
            context.queue.clear();
        }
        context.queue.unshift(message);
        context.cancel();
        context.emitQueue();
        return;
    }
    if (mode === "steer" && context.busy()) {
        context.queue.clear();
        context.queue.push(message);
        context.cancel();
        return;
    }
    if (context.busy()) {
        context.queue.enqueue(message);
        context.emitQueue();
        return;
    }
    context.dispatch(message);
}
