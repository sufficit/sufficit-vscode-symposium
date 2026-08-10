import type { AgentSession } from "../adapters/types";
import type { ChatQueue, PendingMessage, SendMode } from "./controllerQueue";

interface ControllerClientActionDeps {
    queue: ChatQueue;
    getSession(): AgentSession | undefined;
    isBusy(): boolean;
    setBusy(value: boolean): void;
    clearAttention(): void;
    statusChanged(): void;
    onSend(message: PendingMessage, mode: SendMode): void;
    emitQueue(): void;
    dispatch(message: PendingMessage): void;
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
        this.deps.getSession()?.cancel();
    }

    resolveApproval(toolId: string, approved: boolean): boolean {
        const session = this.deps.getSession();
        if (!session?.resolveApproval) return false;
        session.resolveApproval(toolId, approved);
        return true;
    }

    removeQueued(id: string): boolean {
        const changed = this.deps.queue.removeExternal(id);
        if (changed) this.deps.emitQueue();
        return changed;
    }

    reorderQueued(order: readonly string[]): boolean {
        const changed = this.deps.queue.reorderExternal(order);
        if (changed) this.deps.emitQueue();
        return changed;
    }

    promoteQueued(id: string): boolean {
        const queued = this.deps.queue.takeExternal(id);
        if (!queued) return false;
        if (this.deps.isBusy()) {
            this.deps.queue.unshift(queued);
            this.deps.emitQueue();
            this.deps.getSession()?.cancel();
        } else {
            this.deps.emitQueue();
            this.deps.dispatch(queued);
        }
        return true;
    }

    continueTurn(): boolean {
        const session = this.deps.getSession();
        if (this.deps.isBusy() || !session?.continueTurn) return false;
        this.deps.setBusy(true);
        this.deps.clearAttention();
        this.deps.statusChanged();
        session.continueTurn();
        return true;
    }
}
