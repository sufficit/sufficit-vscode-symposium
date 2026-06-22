export type SendMode = "send" | "queue" | "steer";

export interface PendingMessage {
    id?: number;
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

    items(): { id: number | undefined; text: string; attachments: string[] }[] {
        return this.messages.map((message) => ({ id: message.id, text: message.text, attachments: message.attachments }));
    }
}
