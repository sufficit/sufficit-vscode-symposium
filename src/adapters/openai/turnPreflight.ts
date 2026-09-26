import type { AgentEvent } from "../types";
import {
    assessContextWindow,
    estimateRequest,
    requestEstimateDiagnostic,
    type RequestEstimate,
} from "./requestWindow";
import type { TurnRunnerDeps } from "./turnRunnerDeps";

export type PreflightOutcome =
    | { kind: "send"; bodyJson: string; estimate: RequestEstimate }
    | { kind: "retry-hop" }
    | { kind: "stop" };

/** Local context guard run before the request leaves: may compact and redo the
 *  hop, or refuse to send at all (emitting the error itself). */
export async function preflightRequest(
    deps: TurnRunnerDeps,
    body: Record<string, unknown>,
    messageCount: number,
    toolCount: number,
): Promise<PreflightOutcome> {
    const bodyJson = JSON.stringify(body);
    const estimate = estimateRequest(bodyJson, messageCount, toolCount);
    deps.emitRequestEstimate(estimate);
    const contextAssessment = assessContextWindow(
        estimate.inputTokens,
        deps.contextWindow(),
        deps.cfg.autoCompactAt,
    );
    if (contextAssessment.shouldCompact && (await deps.maybeAutoCompact(estimate.inputTokens))) {
        return { kind: "retry-hop" };
    }
    if (contextAssessment.exceedsWindow) {
        // The request does not fit at all. Fold once even when autoCompactAt is
        // 0: that setting only disables *preemptive* compaction, and treating it
        // as "refuse and dead-end" leaves the session unable to continue, since
        // every retry rebuilds the very same oversized request.
        if (await deps.compactForOverflow(estimate.inputTokens)) {
            return { kind: "retry-hop" };
        }
        const diagnostic = requestEstimateDiagnostic(estimate, deps.contextWindow());
        deps.emit({
            kind: "error",
            message: `Request not sent: the local input estimate reaches or exceeds this model's context window. Compaction could not reduce it enough. Reduce the current message or attachments, lower symposium.openai.maxHistoryMessages, choose a compression preset, or select a model with a larger context window.\n${diagnostic}`,
            retryable: false,
        });
        return { kind: "stop" };
    }
    return { kind: "send", bodyJson, estimate };
}

export async function httpFailureEvent(
    deps: TurnRunnerDeps,
    res: Response,
    estimate: RequestEstimate,
    toolActivityStarted = false,
): Promise<AgentEvent> {
    const detail = await res.text().catch(() => "");
    const requiredDirective = res.headers.get("x-sufficit-required-directive");
    const permissionDetail = requiredDirective
        ? `\nX-Sufficit-Required-Directive: ${requiredDirective}`
        : "";
    const diagnostic = requestEstimateDiagnostic(estimate, deps.contextWindow());
    const retryable =
        !toolActivityStarted && (res.status >= 500 || res.status === 429 || res.status === 408);
    const recoveryHint = toolActivityStarted
        ? "\nCompleted tool results are saved; send Continue to resume safely instead of resending the original request."
        : "";
    return {
        kind: "error",
        message:
            `HTTP ${res.status} ${res.statusText} ${detail}${permissionDetail}\n${diagnostic}${recoveryHint}`.trim(),
        retryable,
    };
}
