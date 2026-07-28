export type SendMode = "send" | "queue" | "steer";

export interface PendingMessage {
    id?: number;
    clientMessageId?: string;
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
