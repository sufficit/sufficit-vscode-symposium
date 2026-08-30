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
        const diagnostic = requestEstimateDiagnostic(estimate, deps.contextWindow());
        const autoState =
            (deps.cfg.autoCompactAt ?? 0) > 0
                ? "Automatic compaction could not reduce it enough."
                : "Automatic compaction is disabled.";
        deps.emit({
            kind: "error",
            message: `Request not sent: the local input estimate reaches or exceeds this model's context window. ${autoState} Reduce the current message or attachments, lower symposium.openai.maxHistoryMessages, choose a compression preset, or select a model with a larger context window.\n${diagnostic}`,
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
): Promise<AgentEvent> {
    const detail = await res.text().catch(() => "");
    const requiredDirective = res.headers.get("x-sufficit-required-directive");
    const permissionDetail = requiredDirective
        ? `\nX-Sufficit-Required-Directive: ${requiredDirective}`
        : "";
    const diagnostic = requestEstimateDiagnostic(estimate, deps.contextWindow());
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    return {
        kind: "error",
        message:
            `HTTP ${res.status} ${res.statusText} ${detail}${permissionDetail}\n${diagnostic}`.trim(),
        retryable,
    };
}
