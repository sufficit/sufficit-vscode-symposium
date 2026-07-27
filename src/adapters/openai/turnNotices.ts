import type { AgentEvent } from "../types";

/** Number of identical tool-call batches allowed before stopping the turn. */
export const REPEAT_TOOL_CALL_LIMIT = 6;

/**
 * Records one tool-call batch and tells the caller whether the same batch has
 * now been requested too many times in a bounded recent window. Looking beyond
 * consecutive calls also catches loops that alternate between two equivalent
 * reads (A/B/A/B), while the bounded window still permits a tool to be reused
 * occasionally during a long task.
 *
 * Call this before adding the assistant tool call to durable history: a
 * stopped call has no tool result, and persisting it would leave an invalid
 * OpenAI tool-call pair.
 */
export function repeatedToolCallWithoutProgress(
    recentCalls: string[],
    signature: string,
    limit = REPEAT_TOOL_CALL_LIMIT,
): boolean {
    recentCalls.push(signature);
    const windowSize = limit * 2;
    if (recentCalls.length > windowSize) {
        recentCalls.splice(0, recentCalls.length - windowSize);
    }
    return recentCalls.filter((call) => call === signature).length >= limit;
}

/**
 * Guardrail stops are runtime decisions made by Symposium, not words produced
 * by the model. Keeping them as structured warning notices prevents the UI and
 * transcript from attributing them to the assistant.
 */
export function guardrailStopNotice(text: string): AgentEvent {
    return { kind: "status-notice", severity: "warning", text };
}

/** Reclassifies guardrail messages persisted by versions that emitted them as assistant text. */
export function legacyGuardrailStopNotice(text: string): AgentEvent | null {
    const value = String(text ?? "").trim();
    if (!/^_\(stopped(?::|\s+after\b).*\)_$/i.test(value)) { return null; }
    let message = value.slice(2, -2).trim();
    message = message.charAt(0).toUpperCase() + message.slice(1);
    message = message.replace(/\b(\d+)x\b/g, "$1 times");
    if (!/[.!?]$/.test(message)) { message += "."; }
    return guardrailStopNotice(message);
}
