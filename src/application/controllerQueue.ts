import type { BusySendMode } from "../protocol/sendMode";

export type SendMode = "send" | BusySendMode;

export type QueueHoldReason = "turn-failed" | "restored";

export interface QueueHold {
    reason: QueueHoldReason;
    /** The turn (backend id if bound, else the controller-local turn id)
     *  whose failure caused the hold, when known. */
    turnId?: string;
    at: number;
}

export interface PendingMessage {
    id?: number;
    clientMessageId?: string;
    /**
     * Controller-assigned intent id for this user request. Stable across the
     * turn it drives; the adapter carries it into ledger rows without deciding
     * the relation between messages (no Intent Arbiter yet). Generated in
     * ChatController.dispatch when absent.
     */
    intentId?: string;
    /**
     * Set when this is a Retry: the logicalTurnId of the failed turn being
     * retried (delivery 1C). When present, the adapter reuses that logicalTurnId
     * instead of allocating a new one, so the retry is attributable to the
     * original turn for observability — without duplicating the user message.
     */
    retryOf?: string;
    text: string;
    attachments: string[];
    model?: string;
    reasoning?: string;
    permission?: string;
    autonomy?: string;
    execDisplay?: "silent" | "inline" | "terminal";
    /** How this message was sent; "steer" suppresses the resume-checkpoint inject. */
    mode?: SendMode;
    /** One-shot resume context (latest session checkpoint) prepended for continuity. */
    resumeCheckpoint?: string;
    /**
     * One-shot note explaining what error interrupted the previous turn, set
     * only on a plain "Retry" click (see surfaceBranching.ts's
     * retryLastMessage). Tells the model the user wants to continue and why
     * the flow stopped, instead of a bare "continue" with no context.
     */
    interruptedBy?: string;
    /** True when the text originated from speech-to-text (may have transcription errors). */
    speech?: boolean;
}

/** FIFO queue for pending chat messages; assigns stable ids for webview edits. */
export class ChatQueue {
    private seq = 0;
    private readonly messages: PendingMessage[] = [];
    /**
     * Set when the turn ahead of this queue failed: the queued messages are
     * NOT auto-dispatched (a failure is not a normal continuation point), but
     * they are NOT silently dropped either — the user-authored text stays put
     * until an explicit release (promote / retry / a fresh manual send).
     * Without this flag the hold was invisible: `attentionStatus` (the signal
     * that caused the hold) clears on the NEXT dispatch, so a later, unrelated
     * message would silently drain the stale queue out of order once it
     * finished — the queued text fires with no user intent behind it anymore.
     */
    private held: QueueHold | undefined;

    get isEmpty(): boolean {
        return this.messages.length === 0;
    }

    get length(): number {
        return this.messages.length;
    }

    get isHeld(): boolean {
        return this.held !== undefined;
    }

    get holdInfo(): QueueHold | undefined {
        return this.held;
    }

    /** Marks the queue held after a turn failure — see `held` above. */
    hold(hold: QueueHold = { reason: "turn-failed", at: Date.now() }): void {
        this.held = hold;
    }

    /** Releases a hold (promote / retry / explicit user action). */
    release(): void {
        this.held = undefined;
    }

    enqueue(message: PendingMessage): void {
        message.id = ++this.seq;
        this.messages.push(message);
    }

    push(message: PendingMessage): void {
        this.messages.push(message);
    }

    unshift(message: PendingMessage): void {
        this.messages.unshift(message);
    }

    shift(): PendingMessage | undefined {
        return this.messages.shift();
    }

    take(id: number): PendingMessage | undefined {
        const index = this.messages.findIndex((message) => message.id === id);
        if (index < 0) {
            return undefined;
        }
        const [message] = this.messages.splice(index, 1);
        return message;
    }

    remove(id: number): boolean {
        return this.take(id) !== undefined;
    }

    removeExternal(id: string): boolean {
        return this.takeExternal(id) !== undefined;
    }

    takeExternal(id: string): PendingMessage | undefined {
        const index = this.messages.findIndex(
            (message) => message.clientMessageId === id || String(message.id) === id,
        );
        if (index < 0) return undefined;
        const [message] = this.messages.splice(index, 1);
        return message;
    }

    reorderExternal(order: readonly string[]): boolean {
        const before = this.messages.map(
            (message) => message.clientMessageId ?? String(message.id),
        );
        const rank = new Map(order.map((id, index) => [id, index]));
        this.messages.sort((first, second) => {
            const a = rank.get(first.clientMessageId ?? String(first.id));
            const b = rank.get(second.clientMessageId ?? String(second.id));
            if (a === undefined && b === undefined) return 0;
            if (a === undefined) return 1;
            if (b === undefined) return -1;
            return a - b;
        });
        return before.some(
            (id, index) =>
                id !== (this.messages[index].clientMessageId ?? String(this.messages[index].id)),
        );
    }

    clear(): void {
        this.messages.length = 0;
        this.held = undefined;
    }

    /** Rehydrates a persisted queue and advances the id sequence past it. */
    restore(messages: PendingMessage[]): void {
        this.clear();
        for (const original of messages) {
            const message = { ...original, attachments: [...original.attachments] };
            if (typeof message.id !== "number" || !Number.isFinite(message.id)) {
                message.id = ++this.seq;
            } else {
                this.seq = Math.max(this.seq, message.id);
            }
            this.messages.push(message);
        }
    }

    /** Full durable snapshot; the webview ignores dispatch-only metadata. */
    items(): PendingMessage[] {
        return this.messages.map((message) => ({
            ...message,
            attachments: [...message.attachments],
        }));
    }
}

function sameAttachments(first: string[], second: unknown): boolean {
    return (
        Array.isArray(second) &&
        first.length === second.length &&
        first.every((value, index) => value === second[index])
    );
}

/**
 * Reduces append-only render messages to the queue that was genuinely pending
 * at shutdown. A later user row consumes its matching queued item, covering
 * legacy logs that omitted the final empty queue snapshot during dispatch.
 */
export function recoverPersistedQueue(messages: unknown[]): PendingMessage[] {
    let pending: PendingMessage[] = [];
    for (const raw of messages) {
        const message = raw as {
            type?: unknown;
            items?: unknown;
            text?: unknown;
            attachments?: unknown;
            clientMessageId?: unknown;
        };
        if (message?.type === "queue" && Array.isArray(message.items)) {
            pending = message.items.flatMap((item) => {
                const value = item as Partial<PendingMessage>;
                if (typeof value?.text !== "string") {
                    return [];
                }
                return [
                    {
                        ...value,
                        text: value.text,
                        attachments: Array.isArray(value.attachments)
                            ? value.attachments.filter(
                                  (path): path is string => typeof path === "string",
                              )
                            : [],
                    },
                ];
            });
            continue;
        }
        if (message?.type !== "user" || typeof message.text !== "string") {
            continue;
        }
        const index = pending.findIndex((item) => {
            const queuedId = item.clientMessageId;
            const sentId =
                typeof message.clientMessageId === "string" ? message.clientMessageId : undefined;
            if (queuedId && sentId) {
                return queuedId === sentId;
            }
            return (
                item.text === message.text &&
                sameAttachments(item.attachments, message.attachments ?? [])
            );
        });
        if (index >= 0) {
            pending.splice(index, 1);
        }
    }
    return pending;
}

/**
 * Host-side idempotency index for incoming messages keyed by their webview-local
 * `clientMessageId`. A message sent twice with the same optimistic id (transport
 * double-delivery, webview reconnect replay, a duplicate postMessage) is accepted
 * exactly once: the first call to `accept` returns true and records the id; every
 * later call with the same id returns false so the caller drops it silently (no
 * second dispatch, no second enqueue, no second tool execution). Messages with no
 * clientMessageId bypass dedup entirely (retry/edit-resend legitimately resend).
 *
 * The set grows with the number of accepted messages in a session; it is bounded
 * by user-driven message count and never accumulates tool hops or model turns.
 */
export class MessageDedup {
    private readonly seen = new Set<string>();
    /** Cap to bound memory in a very long-lived session (defect 4.2). */
    private static readonly MAX_SEEN = 5000;
    private order: string[] = [];
    /** Records the id and returns true on first sight, false on a repeat. */
    accept(clientMessageId: string | undefined): boolean {
        if (!clientMessageId) {
            return true;
        } // no id → not deduped
        if (this.seen.has(clientMessageId)) {
            return false;
        }
        this.seen.add(clientMessageId);
        this.order.push(clientMessageId);
        // Evict oldest beyond the cap so the set can't grow unbounded.
        if (this.order.length > MessageDedup.MAX_SEEN) {
            const oldest = this.order.shift();
            if (oldest !== undefined) {
                this.seen.delete(oldest);
            }
        }
        return true;
    }
    /** Whether an id has already been accepted (for introspection/tests). */
    has(clientMessageId: string): boolean {
        return this.seen.has(clientMessageId);
    }
}
