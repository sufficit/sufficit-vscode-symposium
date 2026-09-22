import type { AgentEvent } from "../types";
import type { ChatMessage } from "./types";
import type { MaterializedToolHistory, ToolHistoryIssue } from "./toolHistory";

/** Number of identical tool-call batches allowed before stopping the turn. */
export const REPEAT_TOOL_CALL_LIMIT = 6;
/** A consecutive identical batch has stronger evidence of a stalled loop. */
export const CONSECUTIVE_REPEAT_TOOL_CALL_LIMIT = 3;
/** Duplicate requests skipped internally before an insistent loop is stopped. */
export const REPEATED_TOOL_CALL_RECOVERY_LIMIT = 2;

const TOOL_LOOP_GUARDRAIL_PREFIX = "[Symposium tool-loop guardrail:";

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
    return repeatedToolCallCountWithoutProgress(recentCalls, signature, limit) !== undefined;
}

/**
 * Records one batch and returns the repeat count that tripped the guardrail.
 * Three consecutive identical calls stop early; interleaved reuse retains the
 * wider six-occurrence window so legitimate read/edit/read workflows survive.
 */
export function repeatedToolCallCountWithoutProgress(
    recentCalls: string[],
    signature: string,
    limit = REPEAT_TOOL_CALL_LIMIT,
    consecutiveLimit = CONSECUTIVE_REPEAT_TOOL_CALL_LIMIT,
): number | undefined {
    recentCalls.push(signature);
    const windowSize = limit * 2;
    if (recentCalls.length > windowSize) {
        recentCalls.splice(0, recentCalls.length - windowSize);
    }
    let consecutive = 0;
    for (let index = recentCalls.length - 1; index >= 0; index--) {
        if (recentCalls[index] !== signature) break;
        consecutive++;
    }
    if (consecutive >= consecutiveLimit) return consecutive;
    const occurrences = recentCalls.filter((call) => call === signature).length;
    return occurrences >= limit ? occurrences : undefined;
}

export type RepeatedToolCallDecision =
    | { kind: "execute" }
    | {
          kind: "recover" | "stop";
          attempt: number;
          repeatCount: number | undefined;
          previouslyBlocked: boolean;
      };

/**
 * Turns duplicate model requests into bounded recovery opportunities. A
 * different tool batch proves progress and resets the recovery counter.
 */
export class RepeatedToolCallGuard {
    private readonly recentCalls: string[] = [];
    private blockedFingerprint: string | undefined;
    private recoveryAttempts = 0;
    private triggeringRepeatCount: number | undefined;

    constructor(previouslyBlockedFingerprint?: string) {
        this.blockedFingerprint = previouslyBlockedFingerprint;
    }

    evaluate(signature: string): RepeatedToolCallDecision {
        const fingerprint = toolCallBatchFingerprint(signature);
        const previouslyBlocked = this.blockedFingerprint === fingerprint;
        const repeatCount = previouslyBlocked
            ? this.triggeringRepeatCount
            : repeatedToolCallCountWithoutProgress(this.recentCalls, signature);
        if (!previouslyBlocked && repeatCount === undefined) {
            this.blockedFingerprint = undefined;
            this.recoveryAttempts = 0;
            this.triggeringRepeatCount = undefined;
            return { kind: "execute" };
        }
        if (!previouslyBlocked) this.triggeringRepeatCount = repeatCount;
        this.blockedFingerprint = fingerprint;
        const attempt = ++this.recoveryAttempts;
        return {
            kind: attempt <= REPEATED_TOOL_CALL_RECOVERY_LIMIT ? "recover" : "stop",
            attempt,
            repeatCount: this.triggeringRepeatCount,
            previouslyBlocked,
        };
    }
}

/** Stable opaque identity for a tool-call batch; arguments never enter the feedback text. */
export function toolCallBatchFingerprint(signature: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < signature.length; i++) {
        hash ^= BigInt(signature.charCodeAt(i));
        hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(16).padStart(16, "0");
}

/**
 * Adds model-facing feedback after a repeated-call stop. The message is part of
 * durable provider history, but remains a developer/system instruction rather
 * than being misattributed to the assistant in the rendered transcript.
 */
export function appendRepeatedToolCallFeedback(
    messages: ChatMessage[],
    signature: string,
    toolNames: string[],
    supportsDeveloperRole: boolean,
    limit = REPEAT_TOOL_CALL_LIMIT,
): ChatMessage {
    const fingerprint = toolCallBatchFingerprint(signature);
    const tools = [...new Set(toolNames)].filter(Boolean).slice(0, 4).join(", ") || "tool";
    const feedback: ChatMessage = {
        role: supportsDeveloperRole ? "developer" : "system",
        content: `${TOOL_LOOP_GUARDRAIL_PREFIX}${fingerprint}] The preceding execution was stopped after an identical ${tools} call batch was requested ${limit} times. Do not request that same batch with the same arguments again. Reuse the existing results, take a different action, or answer the user.`,
    };
    messages.push(feedback);
    return feedback;
}

/** Adds durable guidance after Symposium skips a duplicate call without executing it. */
export function appendRepeatedToolCallRecoveryFeedback(
    messages: ChatMessage[],
    signature: string,
    toolNames: string[],
    supportsDeveloperRole: boolean,
    attempt: number,
): ChatMessage {
    const fingerprint = toolCallBatchFingerprint(signature);
    const tools = [...new Set(toolNames)].filter(Boolean).slice(0, 4).join(", ") || "tool";
    const feedback: ChatMessage = {
        role: supportsDeveloperRole ? "developer" : "system",
        content: `${TOOL_LOOP_GUARDRAIL_PREFIX}${fingerprint}] A duplicate ${tools} request was skipped without execution because its result is already available above. Reuse that result and continue the task or answer the user. Do not request the same arguments again. Recovery attempt ${attempt} of ${REPEATED_TOOL_CALL_RECOVERY_LIMIT}.`,
    };
    messages.push(feedback);
    return feedback;
}

/** Selects durable model feedback for a blocked duplicate-call decision. */
export function appendRepeatedToolCallDecisionFeedback(
    messages: ChatMessage[],
    signature: string,
    toolNames: string[],
    supportsDeveloperRole: boolean,
    decision: Exclude<RepeatedToolCallDecision, { kind: "execute" }>,
): ChatMessage {
    return decision.kind === "recover"
        ? appendRepeatedToolCallRecoveryFeedback(
              messages,
              signature,
              toolNames,
              supportsDeveloperRole,
              decision.attempt,
          )
        : appendRepeatedToolCallFeedback(
              messages,
              signature,
              toolNames,
              supportsDeveloperRole,
              decision.repeatCount,
          );
}

/** User-visible notice that a duplicate request was skipped and the turn continues. */
export function repeatedToolCallRecoveryNotice(toolNames: string[], attempt: number): AgentEvent {
    const tools = [...new Set(toolNames)].filter(Boolean).slice(0, 4).join(", ") || "tool";
    return {
        kind: "status-notice",
        severity: "warning",
        text: `Skipped a repeated ${tools} request and asked the model to reuse the existing result (recovery ${attempt} of ${REPEATED_TOOL_CALL_RECOVERY_LIMIT}).`,
    };
}

/** Builds the user-facing stop notice for a repeated or carried-over tool loop. */
export function repeatedToolCallStopNotice(attempt: number): AgentEvent {
    return guardrailStopNotice(
        `Stopped because the model repeated the same tool call after ${Math.max(1, attempt - 1)} recovery instructions.`,
    );
}

/**
 * Adds an explicit recovery hint after a tool returned a structured error.
 * The raw result remains in the tool message, but this makes the next action
 * unambiguous for models that otherwise retry the same invalid arguments.
 */
export function appendToolFailureRecoveryFeedback(
    messages: ChatMessage[],
    toolNames: string[],
    supportsDeveloperRole: boolean,
): ChatMessage {
    const tools = [...new Set(toolNames)].filter(Boolean).slice(0, 4).join(", ") || "tool";
    const feedback: ChatMessage = {
        role: supportsDeveloperRole ? "developer" : "system",
        content: `${tools} failed. Do not repeat the same arguments; use a different action or report the blocker.`,
    };
    messages.push(feedback);
    return feedback;
}

/**
 * Returns the most recent unresolved repeated-call fingerprint. It is active
 * only for the user turn immediately following the stop; any assistant/tool
 * activity in between proves that execution already moved on.
 */
export function activeRepeatedToolCallFingerprint(messages: ChatMessage[]): string | undefined {
    let userIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            userIndex = i;
            break;
        }
    }
    if (userIndex < 0) {
        return undefined;
    }
    for (let i = userIndex - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "assistant" || message.role === "tool" || message.role === "user") {
            return undefined;
        }
        if (typeof message.content !== "string") {
            continue;
        }
        const match = message.content.match(/^\[Symposium tool-loop guardrail:([a-f0-9]{16})\]/);
        if (match) {
            return match[1];
        }
    }
    return undefined;
}

/**
 * Guardrail stops are runtime decisions made by Symposium, not words produced
 * by the model. Keeping them as structured warning notices prevents the UI and
 * transcript from attributing them to the assistant.
 */
export function guardrailStopNotice(text: string): AgentEvent {
    return { kind: "status-notice", severity: "warning", text, terminal: true };
}

/** A bounded tool loop pause with a local action; no instruction is added to model history. */
export function toolHopLimitNotice(maxHops: number): AgentEvent {
    return {
        kind: "status-notice",
        severity: "warning",
        text: `Paused after ${maxHops} tool steps. Continue to let the tool loop make the next request.`,
        terminal: true,
        action: "continue-tool-loop",
    };
}

/** Makes an unexpected SSE drop visible and retryable without losing partial output. */
export function transportInterruptionNotice(detail?: string): AgentEvent {
    const suffix = detail ? ` (${detail})` : "";
    return {
        kind: "error",
        message: `Sufficit AI connection interrupted before the response completed${suffix}. The partial response was preserved; retry to continue.`,
        retryable: true,
    };
}

/**
 * Reports that the dispatched history had to be repaired to satisfy the tool
 * pairing contract. Only the request is affected — the persisted transcript is
 * left untouched — so the notice exists to make that divergence visible.
 * Returns undefined when nothing was folded or repaired.
 */
export function toolHistoryMaterializationNotice(
    materialized: MaterializedToolHistory,
): AgentEvent | undefined {
    if (
        materialized.foldedOrphanTools === 0 &&
        materialized.foldedMissingToolCalls === 0 &&
        materialized.repairedMissingToolCalls === 0
    ) {
        return undefined;
    }
    return {
        kind: "status-notice",
        text: `OpenAI request history materialized from saved session; persisted transcript unchanged. folded_orphan_tools=${materialized.foldedOrphanTools} folded_missing_tool_calls=${materialized.foldedMissingToolCalls} repaired_missing_tool_calls=${materialized.repairedMissingToolCalls}`,
    };
}

/** Reports tool pairing still invalid after materialization; the request is sent unchanged. */
export function toolHistoryPairingNotice(issues: ToolHistoryIssue[]): AgentEvent | undefined {
    if (issues.length === 0) {
        return undefined;
    }
    const orphanCount = issues.filter((issue) => issue.type === "orphan_tool_message").length;
    return {
        kind: "status-notice",
        text: `OpenAI dispatch history has invalid tool pairing; request sent unchanged. orphan_tools=${orphanCount} missing_tool_results=${issues.length - orphanCount}`,
    };
}

/** Reclassifies guardrail messages persisted by versions that emitted them as assistant text. */
export function legacyGuardrailStopNotice(text: string): AgentEvent | null {
    const value = String(text ?? "").trim();
    const paused = value.match(
        /^_\(paused after (\d+) tool steps?\s*[—-]\s*send ["']continue["'] to proceed\)_$/i,
    );
    if (paused) {
        return toolHopLimitNotice(Number(paused[1]));
    }
    if (!/^_\(stopped(?::|\s+after\b).*\)_$/i.test(value)) {
        return null;
    }
    let message = value.slice(2, -2).trim();
    message = message.charAt(0).toUpperCase() + message.slice(1);
    message = message.replace(/\b(\d+)x\b/g, "$1 times");
    if (!/[.!?]$/.test(message)) {
        message += ".";
    }
    return guardrailStopNotice(message);
}
