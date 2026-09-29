import type { HistoryMessage } from "../types";
import { geniusToolSummary } from "./toolSummary";

type RecordValue = Record<string, unknown>;

function string(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Converts `genius sessions show --json` parts into stored-transcript rows.
 * A persisted ToolCall part holds the same text the live stream delivers in
 * two deltas — `name(args)` then ` → result` — so it splits at the first
 * `) → ` (args are JSON, the result is free text).
 */
export function geniusTranscriptMessages(parts: readonly unknown[]): HistoryMessage[] {
    const messages: HistoryMessage[] = [];
    for (const raw of parts) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const part = raw as RecordValue;
        const ts = timestamp(part.createdAt);
        const text = part.expired === true ? "(expired)" : (string(part.text) ?? null);
        switch (part.kind) {
            case "User":
                messages.push({ role: "user", text, ts });
                break;
            case "Markdown":
                if (text) messages.push({ role: "assistant", text, ts });
                break;
            case "Reasoning":
                if (text) messages.push({ role: "thinking", text, ts });
                break;
            case "ToolCall": {
                const body = text ?? "";
                const split = body.indexOf(") → ");
                const call = split >= 0 ? body.slice(0, split + 1) : body;
                const result = split >= 0 ? body.slice(split + 4) : undefined;
                const match = /^([^()\s]+)\((.*)\)$/s.exec(call);
                const toolName = match?.[1] ?? "Genius tool";
                const input = match?.[2] ?? call;
                messages.push({
                    role: "tool",
                    text: toolName,
                    toolName,
                    detail: geniusToolSummary(toolName, input),
                    input,
                    result,
                    ts,
                });
                break;
            }
        }
    }
    return messages;
}
