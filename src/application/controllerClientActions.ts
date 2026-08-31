import type { AgentSession } from "../adapters/types";
import type { ChatQueue, PendingMessage, SendMode } from "./controllerQueue";
import type { PeerQueueCommand } from "./controllerPeerQueue";
import type { TurnTracker } from "./turn";

interface ControllerClientActionDeps {
    queue: ChatQueue;
    getSession(): AgentSession | undefined;
    turns: TurnTracker;
    statusChanged(): void;
    onSend(message: PendingMessage, mode: SendMode): void;
    emitQueue(): void;
    dispatch(message: PendingMessage): void;
    canMutateQueue(): boolean;
    emitPeerQueueCommand(command: PeerQueueCommand): void;
    cancelAutomaticRetry?(): boolean;
    log?(message: string): void;
}

/** Host-authoritative commands shared by API, AHP and legacy webview clients. */
export class ControllerClientActions {
    constructor(private readonly deps: ControllerClientActionDeps) {}

    sendText(text: string, mode: SendMode = "send", clientMessageId?: string): void {
        this.deps.onSend({ text, attachments: [], clientMessageId }, mode);
    }

    sendMessage(message: PendingMessage, mode: SendMode = "send"): void {
        this.deps.onSend({ ...message, attachments: [...message.attachments] }, mode);
    }

    interrupt(): void {
        this.deps.cancelAutomaticRetry?.();
        this.deps.getSession()?.cancel();
    }

    resolveApproval(toolId: string, approved: boolean): boolean {
        const session = this.deps.getSession();
        if (!session?.resolveApproval) return false;
        session.resolveApproval(toolId, approved);
        return true;
    }

    removeQueued(id: string): boolean {
        if (!this.deps.queue.hasExternal(id)) return false;
        if (this.forward({ type: "queue-command", action: "remove", id })) return true;
        const changed = this.deps.queue.removeExternal(id);
        if (changed) this.deps.emitQueue();
        return changed;
    }

    /** Discards every held/queued message at once (the "Discard all" action
     *  on the held-queue banner after a turn failure). */
    clearQueued(): boolean {
        if (this.deps.queue.isEmpty) return false;
        if (this.forward({ type: "queue-command", action: "clear" })) return true;
        this.deps.queue.clear();
        this.deps.emitQueue();
        return true;
    }

    reorderQueued(order: readonly string[]): boolean {
        if (!this.deps.queue.wouldReorderExternal(order)) return false;
        if (this.forward({ type: "queue-command", action: "reorder", order: [...order] })) {
            return true;
        }
        const changed = this.deps.queue.reorderExternal(order);
        if (changed) this.deps.emitQueue();
        return changed;
    }

    promoteQueued(id: string): boolean {
        if (!this.deps.queue.hasExternal(id)) return false;
        if (this.forward({ type: "queue-command", action: "promote", id })) return true;
        const queued = this.deps.queue.takeExternal(id);
        if (!queued) return false;
        // "Send next" is the user's explicit release of a queue paused after
        // failure. Without this, dispatch re-enters with held=true and every
        // normal drain path refuses to run it.
        this.deps.queue.release();
        if (this.deps.turns.isBusy) {
            this.deps.queue.unshift(queued);
            this.deps.emitQueue();
            this.deps.turns.requestCancel();
            this.deps.getSession()?.cancel();
        } else {
            this.deps.emitQueue();
            this.deps.dispatch(queued);
        }
        return true;
    }

    private forward(command: PeerQueueCommand): boolean {
        if (this.deps.canMutateQueue()) return false;
        this.deps.emitPeerQueueCommand(command);
        this.deps.log?.(
            `[render-owner] queue ${command.action} command deferred to the session owner`,
        );
        return true;
    }

    continueTurn(): boolean {
        const session = this.deps.getSession();
        if (this.deps.turns.isBusy || !session?.continueTurn) return false;
        this.deps.cancelAutomaticRetry?.();
        // begin()'s attention is derived undefined while live, so this also
        // clears any stale error badge from the previous turn.
        this.deps.turns.begin("continue").markSent();
        this.deps.statusChanged();
        session.continueTurn();
        return true;
    }
}
