/** Transcript projection from application render events. */
import { legacyGuardrailStopNotice } from "../adapters/openai/turnNotices";
import { withoutContradictoryFinalResponseWarnings } from "./finalResponseState";

/**
 * Reconstructs the visible conversation (user prompts + assistant replies) from
 * a ChatController render log. Tool calls and internal scaffolding are omitted —
 * only the human-readable exchange is carried over (e.g. for backend handoff).
 * Reply metadata is retained because the same rows also feed session restore.
 * Pure functions over the log, extracted from ChatController.
 */
export type TranscriptRow = {
    role: "user" | "assistant";
    text: string;
    thinking?: string;
    model?: string;
    reasoning?: string;
    ts?: number;
};

/** Visible user/assistant rows from the render log. */
export function transcriptMessages(log: unknown[]): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    let assistantBuf = "";
    let thinkingBuf = "";
    let assistantModel: string | undefined;
    let assistantReasoning: string | undefined;
    const flushAssistant = () => {
        const text = assistantBuf.trim();
        const thinking = thinkingBuf.trim();
        // Mirror the webview row model: only streamed assistant TEXT creates a
        // conversation row. Thinking blocks are scaffolding with no row index.
        if (text) {
            rows.push({
                role: "assistant",
                text,
                thinking: thinking || undefined,
                ...(assistantModel ? { model: assistantModel } : {}),
                ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
            });
        }
        assistantBuf = "";
        thinkingBuf = "";
        assistantModel = undefined;
        assistantReasoning = undefined;
    };
    for (const message of withoutContradictoryFinalResponseWarnings(log) as Array<{
        type?: string;
        messages?: unknown[];
        text?: unknown;
        event?: {
            kind?: string;
            text?: string;
            model?: string;
            reasoning?: string;
        };
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
                model?: unknown;
                reasoning?: unknown;
            }>) {
                const text = typeof h?.text === "string" ? h.text : "";
                const thinking = typeof h?.thinking === "string" ? h.thinking : undefined;
                if (h?.role === "user" && typeof h.text === "string") {
                    rows.push({ role: "user", text: h.text });
                } else if (h?.role === "assistant") {
                    if (text) {
                        rows.push({
                            role: "assistant",
                            text,
                            thinking,
                            ...(typeof h.model === "string" && h.model ? { model: h.model } : {}),
                            ...(typeof h.reasoning === "string" && h.reasoning
                                ? { reasoning: h.reasoning }
                                : {}),
                        });
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
                if (typeof message.event.model === "string" && message.event.model) {
                    assistantModel ??= message.event.model;
                }
                if (typeof message.event.reasoning === "string" && message.event.reasoning) {
                    assistantReasoning ??= message.event.reasoning;
                }
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

export type ReplayRow =
    | TranscriptRow
    | { role: "error"; text: string; retryable?: boolean; retryAt?: number }
    | { role: "status-notice"; text: string; severity?: "info" | "warning" | "error" };

/**
 * Same walk as transcriptMessages, but also keeps terminal status-notices
 * (warnings/errors that paused or ended a turn) as their own rows, in their
 * original position relative to the surrounding conversation. transcriptMessages
 * deliberately drops these (it feeds retry/handoff seed text, where they'd be
 * noise) — this is for full visual redisplay on reopen, where dropping a
 * warning that a turn ended on is a real loss: the session badge still shows
 * "stopped with a warning" (derived from live in-memory turn state, unaffected
 * by this) but the reopened transcript never explains why.
 */
export function replayRows(log: unknown[]): ReplayRow[] {
    const rows: ReplayRow[] = [];
    let assistantBuf = "";
    let thinkingBuf = "";
    let assistantModel: string | undefined;
    let assistantReasoning: string | undefined;
    let assistantTs: number | undefined;
    const flushAssistant = () => {
        const text = assistantBuf.trim();
        const thinking = thinkingBuf.trim();
        if (text) {
            inferPreviousUserTimestamp(rows, assistantTs);
            rows.push({
                role: "assistant",
                text,
                thinking: thinking || undefined,
                ...(assistantModel ? { model: assistantModel } : {}),
                ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
                ...(assistantTs !== undefined ? { ts: assistantTs } : {}),
            });
        }
        assistantBuf = "";
        thinkingBuf = "";
        assistantModel = undefined;
        assistantReasoning = undefined;
        assistantTs = undefined;
    };
    for (const message of withoutContradictoryFinalResponseWarnings(log) as Array<{
        type?: string;
        messages?: unknown[];
        text?: unknown;
        ts?: unknown;
        event?: {
            kind?: string;
            text?: string;
            message?: string;
            model?: string;
            reasoning?: string;
            terminal?: boolean;
            severity?: "info" | "warning" | "error";
            retryable?: boolean;
            retryAt?: number;
            ts?: unknown;
        };
    }>) {
        if (message?.type === "history" && Array.isArray(message.messages)) {
            flushAssistant();
            for (const h of message.messages as Array<{
                role?: string;
                text?: unknown;
                thinking?: unknown;
                model?: unknown;
                reasoning?: unknown;
                ts?: unknown;
            }>) {
                const text = typeof h?.text === "string" ? h.text : "";
                const thinking = typeof h?.thinking === "string" ? h.thinking : undefined;
                if (h?.role === "user" && typeof h.text === "string") {
                    const ts = timestamp(h.ts);
                    rows.push({ role: "user", text: h.text, ...(ts !== undefined ? { ts } : {}) });
                } else if (h?.role === "assistant") {
                    if (text) {
                        const ts = timestamp(h.ts);
                        inferPreviousUserTimestamp(rows, ts);
                        rows.push({
                            role: "assistant",
                            text,
                            thinking,
                            ...(typeof h.model === "string" && h.model ? { model: h.model } : {}),
                            ...(typeof h.reasoning === "string" && h.reasoning
                                ? { reasoning: h.reasoning }
                                : {}),
                            ...(ts !== undefined ? { ts } : {}),
                        });
                    }
                } else if (h?.role === "error" && text) {
                    const retryAt = timestamp((h as { retryAt?: unknown }).retryAt);
                    rows.push({
                        role: "error",
                        text,
                        ...((h as { retryable?: unknown }).retryable === true
                            ? { retryable: true }
                            : {}),
                        ...(retryAt !== undefined ? { retryAt } : {}),
                    });
                } else if (h?.role === "status-notice" && text) {
                    const severity = (h as { severity?: unknown }).severity;
                    rows.push({
                        role: "status-notice",
                        text,
                        ...(severity === "info" || severity === "warning" || severity === "error"
                            ? { severity }
                            : {}),
                    });
                }
            }
        } else if (message?.type === "user") {
            flushAssistant();
            if (typeof message.text === "string") {
                const ts = timestamp(message.ts);
                rows.push({
                    role: "user",
                    text: message.text,
                    ...(ts !== undefined ? { ts } : {}),
                });
            }
        } else if (message?.type === "event" && message.event?.kind === "text") {
            if (legacyGuardrailStopNotice(message.event.text || "")) {
                flushAssistant();
            } else {
                if (typeof message.event.model === "string" && message.event.model) {
                    assistantModel ??= message.event.model;
                }
                if (typeof message.event.reasoning === "string" && message.event.reasoning) {
                    assistantReasoning ??= message.event.reasoning;
                }
                assistantTs ??= timestamp(message.event.ts);
                assistantBuf += message.event.text || "";
            }
        } else if (message?.type === "event" && message.event?.kind === "thinking") {
            thinkingBuf += message.event.text || "";
        } else if (message?.type === "event" && message.event?.kind === "turn-end") {
            flushAssistant();
        } else if (message?.type === "event" && message.event?.kind === "status-notice") {
            flushAssistant();
            if (message.event.terminal && message.event.text) {
                rows.push({
                    role: "status-notice",
                    text: message.event.text,
                    severity: message.event.severity,
                });
            }
        } else if (message?.type === "event" && message.event?.kind === "error") {
            flushAssistant();
            if (message.event.message) {
                rows.push({
                    role: "error",
                    text: message.event.message,
                    ...(message.event.retryable === true ? { retryable: true } : {}),
                    ...(timestamp(message.event.retryAt) !== undefined
                        ? { retryAt: timestamp(message.event.retryAt) }
                        : {}),
                });
            }
        } else if (
            message?.type === "event" &&
            (message.event?.kind === "tool-start" || message.event?.kind === "session")
        ) {
            flushAssistant();
        } else if (message?.type === "event" && message.event?.kind === "turn-start") {
            // No-op: just a delimiter, handled by flush on turn-end.
        }
    }
    flushAssistant();
    return rows;
}

/** Plain text representation (user/assistant only, no thinking). */
export function transcriptText(log: unknown[]): string {
    const rows = transcriptMessages(log);
    return rows.map((r) => `${r.role === "user" ? "user" : "assistant"}: ${r.text}`).join("\n\n");
}

function timestamp(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) && value > 0 ? value : undefined;
    }
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function inferPreviousUserTimestamp(
    rows: Array<{ role: string; ts?: number }>,
    assistantTs: number | undefined,
): void {
    if (assistantTs === undefined) return;
    const previous = rows.at(-1);
    if (previous?.role === "user" && previous.ts === undefined) previous.ts = assistantTs;
}
