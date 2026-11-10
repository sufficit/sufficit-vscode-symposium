import type { AgentEvent } from "../types";

export type GeniusCancellationReason =
    | "service_stopping"
    | "user_cancelled"
    | "timeout"
    | "cancelled_unknown";

/** The marker survives older transcript projections that retain only error text. */
export function geniusCancellation(
    reason: unknown,
    fallback: string,
): Extract<AgentEvent, { kind: "error" }> | undefined {
    if (
        reason !== "service_stopping" &&
        reason !== "user_cancelled" &&
        reason !== "timeout" &&
        reason !== "cancelled_unknown"
    ) {
        if (!/^Genius command cancel(?:led|ed)\.?$/i.test(fallback)) return undefined;
        reason = "cancelled_unknown";
    }
    return {
        kind: "error",
        message: `[Genius ${reason}] ${fallback}`,
        cancellationReason: reason as GeniusCancellationReason,
        retryable: false,
        automaticRetry: false,
    };
}

export const GENIUS_CONTINUATION_PROMPT =
    "Continue from the saved progress in this session. Do not repeat completed tools or the original request. Verify any tool with an unknown outcome before acting again.";
