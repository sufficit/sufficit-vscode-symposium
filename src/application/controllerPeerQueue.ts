import type { RenderLogRecord } from "../renderLog";
import { ChatQueue, recoverPersistedQueue } from "./controllerQueue";

export type PeerQueueCommand =
    | { type: "queue-command"; action: "promote" | "remove"; id: string }
    | { type: "queue-command"; action: "clear" }
    | { type: "queue-command"; action: "reorder"; order: string[] };

interface PeerQueueCommandTarget {
    promoteQueued(id: string): boolean;
    removeQueued(id: string): boolean;
    clearQueued(): boolean;
    reorderQueued(order: readonly string[]): boolean;
}

export function applyPeerQueueCommand(
    command: PeerQueueCommand,
    target: PeerQueueCommandTarget,
    log?: (message: string) => void,
): void {
    log?.(`[render-owner] applying peer queue ${command.action} command`);
    switch (command.action) {
        case "promote":
            target.promoteQueued(command.id);
            break;
        case "remove":
            target.removeQueued(command.id);
            break;
        case "clear":
            target.clearQueued();
            break;
        case "reorder":
            target.reorderQueued(command.order);
            break;
    }
}

export function createQueueSnapshot(queue: ChatQueue, busy: boolean): unknown {
    return { type: "queue", items: queue.items(), held: queue.isHeld, busy };
}

interface PeerQueueContext {
    queue: ChatQueue;
    isOwner: boolean;
    emitCanonical(): void;
    ingestNormalized(message: unknown): void;
    snapshot(): unknown;
    drain(): void;
    applyCommand(command: PeerQueueCommand): void;
}

/** Reconciles follower proposals and owner snapshots without projecting raw races. */
export function reconcilePeerQueue(
    message: unknown,
    record: RenderLogRecord,
    context: PeerQueueContext,
): boolean | void {
    const value = message as {
        type?: unknown;
        items?: unknown;
        held?: unknown;
        action?: unknown;
        id?: unknown;
        order?: unknown;
    } | null;
    if (value?.type === "queue-command") {
        const command = parseQueueCommand(value);
        if (command && context.isOwner && !record.authoritative) {
            context.applyCommand(command);
        }
        // Commands are internal owner-control records, never transcript rows.
        return false;
    }
    if (value?.type !== "queue" || !Array.isArray(value.items)) return;
    const pending = recoverPersistedQueue([message]);
    if (record.authoritative) {
        context.queue.restore(pending);
    } else {
        context.queue.merge(pending, record.writer?.id ?? "legacy");
    }
    if (value.held === true && pending.length > 0) {
        context.queue.hold({ reason: "restored", at: Date.now() });
    }
    // Followers propose; only the owner persists their union as canonical.
    if (context.isOwner && !record.authoritative) {
        context.emitCanonical();
    } else {
        context.ingestNormalized(context.snapshot());
    }
    context.drain();
    return false;
}

function parseQueueCommand(value: {
    action?: unknown;
    id?: unknown;
    order?: unknown;
}): PeerQueueCommand | undefined {
    if ((value.action === "promote" || value.action === "remove") && typeof value.id === "string") {
        return { type: "queue-command", action: value.action, id: value.id };
    }
    if (value.action === "clear") {
        return { type: "queue-command", action: "clear" };
    }
    if (
        value.action === "reorder" &&
        Array.isArray(value.order) &&
        value.order.every((id): id is string => typeof id === "string")
    ) {
        return { type: "queue-command", action: "reorder", order: [...value.order] };
    }
    return undefined;
}
