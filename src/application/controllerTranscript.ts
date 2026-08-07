/** Transcript projection from application render events. */
import { legacyGuardrailStopNotice } from "../adapters/openai/turnNotices";

/**
 * Reconstructs the visible conversation (user prompts + assistant replies) from
 * a ChatController render log. Tool calls and internal scaffolding are omitted —
 * only the human-readable exchange is carried over (e.g. for backend handoff).
 * Pure functions over the log, extracted from ChatController.
 */
export type TranscriptRow = { role: "user" | "assistant"; text: string; thinking?: string };

/** Visible user/assistant rows from the render log. */
export function transcriptMessages(log: unknown[]): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    let assistantBuf = "";
    let thinkingBuf = "";
    const flushAssistant = () => {
        const text = assistantBuf.trim();
        const thinking = thinkingBuf.trim();
        // Mirror the webview row model: only streamed assistant TEXT creates a
        // conversation row. Thinking blocks are scaffolding with no row index.
        if (text) {
            rows.push({ role: "assistant", text, thinking: thinking || undefined });
        }
        assistantBuf = "";
        thinkingBuf = "";
    };
    for (const message of log as Array<{
        type?: string;
        messages?: unknown[];
        text?: unknown;
        event?: { kind?: string; text?: string };
    }>) {
        if (message?.type === "history" && Array.isArray(message.messages)) {
            // Resumed/seeded history: a single log entry holding the prior
            // conversation. Expand its user/assistant turns so a rewind from a
            // resumed session keeps the full context (tool/thinking rows are
            // scaffolding and stay omitted, like live turns).
            flushAssistant();
            for (const h of message.messages as Array<{
                role?: string;
                text?: unknown;
                thinking?: unknown;
            }>) {
                const text = typeof h?.text === "string" ? h.text : "";
                const thinking = typeof h?.thinking === "string" ? h.thinking : undefined;
                if (h?.role === "user" && typeof h.text === "string") {
                    rows.push({ role: "user", text: h.text });
                } else if (h?.role === "assistant") {
                    if (text) {
                        rows.push({ role: "assistant", text, thinking });
                    }
                }
            }
        } else if (message?.type === "user") {
            flushAssistant();
            if (typeof message.text === "string") {
                rows.push({ role: "user", text: message.text });
            }
        } else if (message?.type === "event" && message.event?.kind === "text") {
            if (legacyGuardrailStopNotice(message.event.text || "")) {
                flushAssistant();
            } else {
                assistantBuf += message.event.text || "";
            }
        } else if (message?.type === "event" && message.event?.kind === "thinking") {
            thinkingBuf += message.event.text || "";
        } else if (message?.type === "event" && message.event?.kind === "turn-end") {
            flushAssistant();
        } else if (
            message?.type === "event" &&
            (message.event?.kind === "tool-start" ||
                message.event?.kind === "error" ||
                message.event?.kind === "status-notice" ||
                message.event?.kind === "session")
        ) {
            // The webview closes the active assistant bubble before these
            // rows. Flush here too, so text -> tool/status/error/session ->
            // text becomes two assistant rows in the same index space.
            flushAssistant();
        } else if (message?.type === "event" && message.event?.kind === "turn-start") {
            // No-op: just a delimiter, handled by flush on turn-end.
        }
    }
    flushAssistant();
    return rows;
}

/**
 * Visible user/assistant rows up to and including the given conversation-row
 * index (0-based, inclusive). The index is a CONVERSATION-ROW index (i.e. the
 * position in the array returned by transcriptMessages), NOT a raw render-log
 * position — this matches what the webview sends (conversationRows indexes).
 */
export function transcriptMessagesUpTo(log: unknown[], index: number): TranscriptRow[] {
    return transcriptMessages(log).slice(0, index + 1);
}

/** Plain text representation (user/assistant only, no thinking). */
export function transcriptText(log: unknown[]): string {
    const rows = transcriptMessages(log);
    return rows.map((r) => `${r.role === "user" ? "user" : "assistant"}: ${r.text}`).join("\n\n");
}
