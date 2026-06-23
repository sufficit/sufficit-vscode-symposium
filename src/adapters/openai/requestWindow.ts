import { ChatMessage } from "./types";

export interface RequestEstimate {
    inputTokens: number;
    requestChars: number;
    messageCount: number;
    toolCount: number;
}

/**
 * Sliding-window view of the message array for outbound requests.
 *
 * Always keeps:
 *   1. The system/developer prefix (session init prompts + one-shot preambles).
 *   2. Up to `max` of the most recent conversation tail.
 *
 * The first user message is intentionally NOT pinned: in a long, multi-task
 * session that permanently re-injects the ORIGINAL task into every request, so
 * the model keeps drifting back to it. The recent window carries the task in
 * progress; for short sessions the first message is still in-window. The caller
 * keeps the full array for persistence/ledger.
 */
export function windowMessages(messages: ChatMessage[], max: number): ChatMessage[] {
    if (max === 0) { return messages; }
    const firstUserIdx = messages.findIndex((m) => m.role === "user");
    if (firstUserIdx === -1) { return messages; }
    const prefix = messages.slice(0, firstUserIdx);
    const conv = messages.slice(firstUserIdx);
    if (conv.length <= max) { return messages; }
    return [...prefix, ...conv.slice(conv.length - max)];
}

/** True when the sliding window is dropping older turns (so the raw task /
 *  earlier steps are no longer in the request — when the anchor matters). */
export function isWindowTruncated(messages: ChatMessage[], max: number): boolean {
    if (max === 0) { return false; }
    const firstUserIdx = messages.findIndex((m) => m.role === "user");
    if (firstUserIdx === -1) { return false; }
    return (messages.length - firstUserIdx) > max;
}

/**
 * Local preflight estimate for requests that may fail before the provider emits
 * a final usage chunk. It intentionally uses the serialized request body,
 * because tool schemas and tool-call history both consume context even though
 * they are not visible as plain chat text in the transcript.
 */
export function estimateRequest(bodyJson: string, messageCount: number, toolCount: number): RequestEstimate {
    return {
        inputTokens: Math.max(1, Math.ceil(bodyJson.length / 4)),
        requestChars: bodyJson.length,
        messageCount,
        toolCount,
    };
}

/** Human-readable preflight details appended to HTTP failures. */
export function requestEstimateDiagnostic(estimate: RequestEstimate, win: number): string {
    const pct = win ? Math.round((estimate.inputTokens / win) * 100) : 0;
    return [
        "Request estimate:",
        `input_tokens≈${estimate.inputTokens}`,
        `context_window=${win || "unknown"}`,
        win ? `used≈${pct}%` : undefined,
        `request_chars=${estimate.requestChars}`,
        `messages=${estimate.messageCount}`,
        `tools=${estimate.toolCount}`,
    ].filter(Boolean).join(" ");
}
