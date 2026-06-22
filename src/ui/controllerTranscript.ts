/**
 * Reconstructs the visible conversation (user prompts + assistant replies) from
 * a ChatController render log. Tool calls and internal scaffolding are omitted —
 * only the human-readable exchange is carried over (e.g. for backend handoff).
 * Pure functions over the log, extracted from ChatController.
 */
export type TranscriptRow = { role: "user" | "assistant"; text: string };

/** Visible user/assistant rows from the render log. */
export function transcriptMessages(log: unknown[]): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    let assistantBuf = "";
    const flushAssistant = () => {
        const text = assistantBuf.trim();
        if (text) { rows.push({ role: "assistant", text }); }
        assistantBuf = "";
    };
    for (const message of log as any[]) {
        if (message?.type === "user" && typeof message.text === "string") {
            flushAssistant();
            const text = message.text.trim();
            if (text) { rows.push({ role: "user", text }); }
        } else if (message?.type === "event" && message.event?.kind === "text") {
            assistantBuf += message.event.text;
        } else if (message?.type === "event" && message.event?.kind === "turn-end") {
            flushAssistant();
        }
    }
    flushAssistant();
    return rows;
}

/** Plain-text transcript ("User: …\n\nAssistant: …") from the render log. */
export function transcriptText(log: unknown[]): string {
    return transcriptMessages(log)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
        .join("\n\n");
}

/** Visible rows up to and including `index` (0-based). */
export function transcriptMessagesUpTo(log: unknown[], index: number): TranscriptRow[] {
    if (index < 0) { return []; }
    return transcriptMessages(log).slice(0, index + 1);
}

/** Plain-text transcript up to and including `index` (0-based). */
export function transcriptUpTo(log: unknown[], index: number): string {
    return transcriptMessagesUpTo(log, index)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
        .join("\n\n");
}
