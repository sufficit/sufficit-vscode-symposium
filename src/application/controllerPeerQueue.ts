import type { RenderLogRecord } from "../renderLog";
import { ChatQueue, recoverPersistedQueue } from "./controllerQueue";

interface PeerQueueContext {
    queue: ChatQueue;
    isOwner: boolean;
    emitCanonical(): void;
    ingestNormalized(message: unknown): void;
    snapshot(): unknown;
    drain(): void;
}

/** Reconciles follower proposals and owner snapshots without projecting raw races. */
export function reconcilePeerQueue(
    message: unknown,
    record: RenderLogRecord,
    context: PeerQueueContext,
): boolean | void {
    const value = message as { type?: unknown; items?: unknown; held?: unknown } | null;
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
