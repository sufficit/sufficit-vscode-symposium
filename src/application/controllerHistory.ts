/** Session-history loading independent of a concrete view. */
import type { AgentAdapter, HistoryMessage, SessionInfo } from "../adapters/types";
import * as renderLog from "../renderLog";
import { replayRows } from "./controllerTranscript";

/**
 * Loads a backend transcript page and normalizes failures into render events.
 * When {@link cursor} is omitted, loads the most recent page; when present,
 * loads the next older page. Returns the page's nextCursor so callers can
 * drive further pagination, or undefined when the transcript is exhausted.
 *
 * CLI backends (codex, claude) often lose the user's typed messages in their
 * native JSONL (they only log injected system context). The Symposium render
 * log preserves the full lossless transcript including user bubbles, tool rows
 * and diffs. When a render log exists for the session, it is preferred over
 * the adapter's lossy reconstruction.
 */
export async function loadControllerHistory(
    adapter: AgentAdapter,
    info: SessionInfo,
    emit: (message: unknown) => void,
    cursor?: string,
): Promise<string | undefined> {
    // The first page (no cursor): prefer the render log when it has content.
    // Paginated (cursor set) loads fall through to the adapter, which pages the
    // native JSONL for older turns beyond what the render log captured.
    if (!cursor) {
        const hasRenderLog = renderLog.hasRender(info.sessionId);
        if (hasRenderLog) {
            const messages = historyFromRenderLog(info);
            if (messages.length > 0) {
                emit({ type: "history", messages, replace: true });
                return undefined;
            }
        }
    }
    if (!adapter.history) {
        return undefined;
    }
    try {
        const page = await adapter.history(info, cursor);
        emit({
            type: "history",
            messages: page.messages,
            replace: cursor === undefined,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
        return page.nextCursor;
    } catch (error) {
        emit({
            type: "event",
            event: {
                kind: "error",
                message: `failed to load history: ${error instanceof Error ? error.message : error}`,
            },
        });
        return undefined;
    }
}

/** Converts the Symposium render log into HistoryMessages (lossless). */
function historyFromRenderLog(info: SessionInfo): HistoryMessage[] {
    try {
        const log = renderLog.readRender(info.sessionId);
        const rows = replayRows(log);
        const messages: HistoryMessage[] = [];
        for (const row of rows) {
            if (row.role === "user") {
                messages.push({
                    role: "user",
                    text: row.text,
                    ...(row.ts !== undefined ? { ts: row.ts } : {}),
                });
            } else if (row.role === "assistant") {
                // Older render logs have no per-message metadata. Use the
                // durable last-known session values as a compatibility fallback.
                const model = row.model || info.model;
                const reasoning = row.reasoning || info.reasoning;
                messages.push({
                    role: "assistant",
                    text: row.text,
                    ...(model ? { model } : {}),
                    ...(reasoning ? { reasoning } : {}),
                    ...(row.ts !== undefined ? { ts: row.ts } : {}),
                });
            } else if (row.role === "error") {
                messages.push({
                    role: "error",
                    text: row.text,
                    ...(row.retryable === true ? { retryable: true } : {}),
                });
            } else if (row.role === "status-notice") {
                messages.push({ role: "status-notice", text: row.text, severity: row.severity });
            }
        }
        return messages;
    } catch {
        return [];
    }
}
