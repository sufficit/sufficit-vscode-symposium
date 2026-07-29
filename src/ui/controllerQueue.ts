export type SendMode = "send" | "queue" | "steer" | "redirect";

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
}

/** FIFO queue for pending chat messages; assigns stable ids for webview edits. */
export class ChatQueue {
    private seq = 0;
    private readonly messages: PendingMessage[] = [];

    get isEmpty(): boolean {
        return this.messages.length === 0;
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

    clear(): void {
        this.messages.length = 0;
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
        return this.messages.map((message) => ({ ...message, attachments: [...message.attachments] }));
    }
}

function sameAttachments(first: string[], second: unknown): boolean {
    return Array.isArray(second)
        && first.length === second.length
        && first.every((value, index) => value === second[index]);
}

/**
 * Reduces append-only render messages to the queue that was genuinely pending
 * at shutdown. A later user row consumes its matching queued item, covering
 * legacy logs that omitted the final empty queue snapshot during dispatch.
 */
export function recoverPersistedQueue(messages: unknown[]): PendingMessage[] {
    let pending: PendingMessage[] = [];
    for (const raw of messages) {
        const message = raw as { type?: unknown; items?: unknown; text?: unknown; attachments?: unknown; clientMessageId?: unknown };
        if (message?.type === "queue" && Array.isArray(message.items)) {
            pending = message.items.flatMap((item) => {
                const value = item as Partial<PendingMessage>;
                if (typeof value?.text !== "string") { return []; }
                return [{
                    ...value,
                    text: value.text,
                    attachments: Array.isArray(value.attachments)
                        ? value.attachments.filter((path): path is string => typeof path === "string")
                        : [],
                }];
            });
            continue;
        }
        if (message?.type !== "user" || typeof message.text !== "string") { continue; }
        const index = pending.findIndex((item) => {
            const queuedId = item.clientMessageId;
            const sentId = typeof message.clientMessageId === "string" ? message.clientMessageId : undefined;
            if (queuedId && sentId) { return queuedId === sentId; }
            return item.text === message.text && sameAttachments(item.attachments, message.attachments ?? []);
        });
        if (index >= 0) { pending.splice(index, 1); }
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
    /** Records the id and returns true on first sight, false on a repeat. */
    accept(clientMessageId: string | undefined): boolean {
        if (!clientMessageId) { return true; }   // no id → not deduped
        if (this.seen.has(clientMessageId)) { return false; }
        this.seen.add(clientMessageId);
        return true;
    }
    /** Whether an id has already been accepted (for introspection/tests). */
    has(clientMessageId: string): boolean { return this.seen.has(clientMessageId); }
}
