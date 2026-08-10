import { ChatMessage } from "./types";
import { isTransientErrorMessage } from "../transientError";
import { filterTools } from "../aiTools/defs";
import * as ledger from "../../ledger";
import { toResponsesInput } from "./transform";
import { consumeStream } from "./streamConsume";
import {
    assessContextWindow,
    windowMessages,
    isWindowTruncated,
    estimateRequest,
    requestEstimateDiagnostic,
} from "./requestWindow";
import { stripSourcePrefix } from "./toolMerge";
import { findToolHistoryIssues, materializeToolSafeHistory } from "./toolHistory";
import { makeAttemptId } from "./turnId";
import { emitTurnUsage } from "./turnUsage";
import {
    activeRepeatedToolCallFingerprint,
    appendRepeatedToolCallFeedback,
    guardrailStopNotice,
    REPEAT_TOOL_CALL_LIMIT,
    repeatedToolCallWithoutProgress,
    toolCallBatchFingerprint,
    toolHistoryMaterializationNotice,
    toolHistoryPairingNotice,
    toolHopLimitNotice,
} from "./turnNotices";
import { TurnRunnerDeps } from "./turnRunnerDeps";
import { shouldRefreshNativeAuthorization } from "./httpAuth";
import { executeToolCallBatch } from "./turnToolBatch";
import { TurnCompression } from "./turnCompression";
import { prepareTurnAccess } from "./turnAccess";
import { RunSequence } from "./runSequence";

export type { TurnRunnerDeps } from "./turnRunnerDeps";

export class TurnRunner {
    private abort: AbortController | undefined;
    // Aborting only kills the in-flight request; each hop allocates a fresh
    // controller, so without this latch the tool loop just runs on.
    private cancelled = false;
    private pendingTasksCompact = false;
    private readonly runSequence = new RunSequence();

    constructor(private readonly d: TurnRunnerDeps) {}

    cancel(): void {
        this.cancelled = true;
        this.abort?.abort();
    }

    async run(): Promise<void> {
        const isCurrentRun = this.runSequence.start();
        this.cancelled = false;
        const messages = this.d.getMessages();
        const progress = this.d.getProgress();
        this.abort = new AbortController();
        const logicalTurnId = this.d.resumeTurn(this.d.getResumeTurnId?.());
        const intentId = this.d.getIntentId();
        const turnStartedAt = Date.now();
        this.d.emit({ kind: "turn-start", logicalTurnId, ...(intentId ? { intentId } : {}) });
        const emitTurnEnd = () =>
            this.d.emit({
                kind: "turn-end",
                durationMs: Date.now() - turnStartedAt,
                logicalTurnId,
            });
        const responses = this.d.cfg.api === "responses";
        const base = this.d.cfg.baseUrl.replace(/\/+$/, "");
        const url = base + (responses ? "/responses" : "/chat/completions");
        const effort = this.d.options.reasoning;
        const compression = new TurnCompression(this.d);
        const requestMessages = (): ChatMessage[] => compression.apply(messages);
        const access = await prepareTurnAccess(this.d, responses);
        if (!access) {
            if (isCurrentRun()) {
                emitTurnEnd();
            }
            return;
        }
        let { loginToken } = access;
        const { noExplicitAuth, finalTools } = access;

        const unlimited = this.d.options.autonomy === "away";
        const HARD_CAP = 200;
        const softCap = unlimited ? HARD_CAP : Math.max(1, this.d.cfg.maxToolHops ?? 50);
        const maxHops = Math.min(softCap, HARD_CAP);
        let hitCap = !unlimited; // cleared when the model finishes on its own
        let toolHistoryMaterializationNoticeEmitted = false;
        const recentCalls: string[] = [];
        let blockedRepeatFingerprint = activeRepeatedToolCallFingerprint(messages);
        const noProgressStop = Math.max(0, this.d.cfg.noProgressStop ?? 0);
        let noTextHops = 0;
        try {
            for (let hop = 0; hop < maxHops; hop++) {
                if (this.cancelled || !isCurrentRun()) {
                    hitCap = false;
                    break;
                }
                this.abort = new AbortController();
                const currentMessages = requestMessages();
                const windowed = windowMessages(
                    currentMessages,
                    this.d.cfg.maxHistoryMessages ?? 40,
                );
                const anchor =
                    isWindowTruncated(messages, this.d.cfg.maxHistoryMessages ?? 40) || hop >= 3
                        ? this.d.followupAnchor()
                        : undefined;
                const materialized = materializeToolSafeHistory(
                    anchor ? [...windowed, anchor] : windowed,
                    this.d.cfg.supportsDeveloperRole !== false ? "developer" : "system",
                );
                const outMessages = materialized.messages;
                const materializationNotice = toolHistoryMaterializationNotice(materialized);
                if (materializationNotice && !toolHistoryMaterializationNoticeEmitted) {
                    this.d.emit(materializationNotice);
                    toolHistoryMaterializationNoticeEmitted = true;
                }
                const pairingNotice = toolHistoryPairingNotice(findToolHistoryIssues(outMessages));
                if (pairingNotice) {
                    this.d.emit(pairingNotice);
                }
                const body: Record<string, unknown> = responses
                    ? { model: this.d.model(), input: toResponsesInput(outMessages), stream: true }
                    : {
                          model: this.d.model(),
                          messages: outMessages,
                          stream: true,
                          stream_options: { include_usage: true },
                      };
                const allow = this.d.options.aiTools;
                const toolList = filterTools<{ function?: { name: string }; name?: string }>(
                    finalTools as { function?: { name: string }; name?: string }[],
                    allow,
                );
                if (toolList.length > 0) {
                    body.tools = toolList;
                    body.tool_choice = "auto";
                }
                if (effort && effort !== "default") {
                    if (responses) {
                        body.reasoning = { effort };
                    } else {
                        body.reasoning_effort = effort;
                    }
                }
                const bodyJson = JSON.stringify(body);
                const estimate = estimateRequest(bodyJson, outMessages.length, toolList.length);
                this.d.emitRequestEstimate(estimate);
                const contextAssessment = assessContextWindow(
                    estimate.inputTokens,
                    this.d.contextWindow(),
                    this.d.cfg.autoCompactAt,
                );
                if (
                    contextAssessment.shouldCompact &&
                    (await this.d.maybeAutoCompact(estimate.inputTokens))
                ) {
                    hop--;
                    continue;
                }
                if (contextAssessment.exceedsWindow) {
                    const diagnostic = requestEstimateDiagnostic(estimate, this.d.contextWindow());
                    const autoState =
                        (this.d.cfg.autoCompactAt ?? 0) > 0
                            ? "Automatic compaction could not reduce it enough."
                            : "Automatic compaction is disabled.";
                    this.d.emit({
                        kind: "error",
                        message: `Request not sent: the local input estimate reaches or exceeds this model's context window. ${autoState} Reduce the current message or attachments, lower symposium.openai.maxHistoryMessages, choose a compression preset, or select a model with a larger context window.\n${diagnostic}`,
                        retryable: false,
                    });
                    hitCap = false;
                    break;
                }
                this.d.cfg.log?.(
                    `[${this.d.backend}] POST ${url} api=${this.d.cfg.api} model=${this.d.model()} tools=${toolList.length} hop=${hop}`,
                );
                const attemptId = makeAttemptId(logicalTurnId, hop + 1);
                ledger.recordRequest(this.d.sessionId, body, attemptId);
                const requestStartedAt = Date.now();
                const signal = this.abort.signal;
                const post = (token: string | null | undefined) => {
                    const headers = this.d.headers(token);
                    // Lets the gateway activity page show the requested model before it has
                    // buffered/bound a potentially very large request body. The server treats
                    // this as an unverified hint and confirms the preset independently.
                    headers["X-Sufficit-Requested-Model"] = this.d.model();
                    return fetch(url, { method: "POST", headers, body: bodyJson, signal });
                };
                let res = await post(loginToken);
                if (shouldRefreshNativeAuthorization(res.status, noExplicitAuth, loginToken)) {
                    const refreshedToken = await this.d.authToken(true);
                    if (refreshedToken) {
                        // Drain the rejected response before reusing the pooled
                        // connection. The model request was not dispatched on
                        // 401/403, so this single retry cannot duplicate a turn.
                        await res.arrayBuffer().catch(() => undefined);
                        this.d.emit({
                            kind: "status-notice",
                            text: "Sufficit AI authorization refreshed; retrying once.",
                        });
                        loginToken = refreshedToken;
                        res = await post(loginToken);
                    }
                }
                const responseStartedAt = Date.now();
                if (!res.ok || !res.body) {
                    const detail = await res.text().catch(() => "");
                    const requiredDirective = res.headers.get("x-sufficit-required-directive");
                    const permissionDetail = requiredDirective
                        ? `\nX-Sufficit-Required-Directive: ${requiredDirective}`
                        : "";
                    const diagnostic = requestEstimateDiagnostic(estimate, this.d.contextWindow());
                    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
                    this.d.emit({
                        kind: "error",
                        message:
                            `HTTP ${res.status} ${res.statusText} ${detail}${permissionDetail}\n${diagnostic}`.trim(),
                        retryable,
                    });
                    hitCap = false;
                    break;
                }
                const m = this.d.model();
                const { text, reasoning, toolCalls, aborted, usage } = await consumeStream(
                    res.body,
                    m,
                    { requestStartedAt, responseStartedAt },
                    responses,
                    {
                        onText: (delta) =>
                            this.d.emit({
                                kind: "text",
                                text: delta,
                                model: m,
                                modelLabel: this.d.label(m),
                            }),
                        onReasoning: (delta) => this.d.emit({ kind: "thinking", text: delta }),
                        onError: (message) => this.d.emit({ kind: "error", message }),
                        onStatusNotice: (notice) =>
                            this.d.emit({ kind: "status-notice", text: notice }),
                    },
                );

                if (usage) {
                    emitTurnUsage(this.d, usage);
                }

                await this.d.maybeAutoCompact();

                if (aborted) {
                    if (toolCalls.length > 0) {
                        messages.push({
                            role: "assistant",
                            content: text || null,
                            tool_calls: toolCalls,
                        });
                        if (text) {
                            this.d.led("assistant", text);
                        }
                        // Satisfy the API contract: every tool_call needs a tool reply.
                        for (const tc of toolCalls) {
                            messages.push({
                                role: "tool",
                                tool_call_id: tc.id,
                                name: tc.function.name,
                                content: "(interrupted before execution)",
                            });
                        }
                    } else if (text) {
                        messages.push({ role: "assistant", content: text, model: this.d.model() });
                        this.d.led("assistant", text);
                    }
                    hitCap = false;
                    break;
                }

                if (toolCalls.length === 0) {
                    messages.push({
                        role: "assistant",
                        content: text || "",
                        model: this.d.model(),
                    });
                    if (text) {
                        this.d.led("assistant", text);
                    }
                    if (!text.trim() && !reasoning.trim()) {
                        this.d.emit({
                            kind: "status-notice",
                            text: "The model returned an empty response (no content). Try resending, a different model, or a lower reasoning effort.",
                        });
                    }
                    hitCap = false;
                    break;
                }

                if (noProgressStop > 0) {
                    if (text.trim()) {
                        noTextHops = 0;
                    } else {
                        noTextHops++;
                    }
                    if (noTextHops === Math.ceil(noProgressStop / 2)) {
                        const nudgeRole =
                            this.d.cfg.supportsDeveloperRole !== false ? "developer" : "system";
                        messages.push({
                            role: nudgeRole,
                            content:
                                "[Convergence] You have run several tools in a row without replying. If you already have enough information, STOP calling tools and answer now; otherwise take only the single next necessary step.",
                        });
                    }
                    if (noTextHops >= noProgressStop) {
                        this.d.emit(
                            guardrailStopNotice(
                                `Stopped after ${noTextHops} tool steps without a reply. Send "continue" to resume.`,
                            ),
                        );
                        hitCap = false;
                        break;
                    }
                }

                const sig = toolCalls
                    .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
                    .join("|");
                const repeatsPreviouslyBlockedCall =
                    blockedRepeatFingerprint === toolCallBatchFingerprint(sig);
                if (
                    repeatsPreviouslyBlockedCall ||
                    repeatedToolCallWithoutProgress(recentCalls, sig)
                ) {
                    if (!repeatsPreviouslyBlockedCall) {
                        const feedback = appendRepeatedToolCallFeedback(
                            messages,
                            sig,
                            toolCalls.map((tc) => stripSourcePrefix(tc.function.name)),
                            this.d.cfg.supportsDeveloperRole !== false,
                        );
                        this.d.led(feedback.role, feedback.content, { kind: "guardrail-feedback" });
                        this.d.safePersist();
                    }
                    this.d.emit(
                        guardrailStopNotice(
                            `Stopped because the model repeated the same tool call ${REPEAT_TOOL_CALL_LIMIT} times without progress.`,
                        ),
                    );
                    hitCap = false;
                    break;
                }
                blockedRepeatFingerprint = undefined;
                this.pendingTasksCompact =
                    (await executeToolCallBatch({
                        deps: this.d,
                        messages,
                        progress,
                        toolCalls,
                        text,
                        abortSignal: this.abort?.signal,
                    })) || this.pendingTasksCompact;
                // loop again so the model can use the tool results
            }
            if (hitCap) {
                this.d.emit(toolHopLimitNotice(maxHops));
                this.d.markPausedForContinuation?.();
            }
        } catch (error) {
            if (!isCurrentRun()) {
                return;
            }
            if ((error as { name?: string })?.name !== "AbortError") {
                const msg = error instanceof Error ? error.message : String(error);
                this.d.emit({
                    kind: "error",
                    message: msg,
                    retryable: isTransientErrorMessage(msg),
                });
            }
        }
        if (!isCurrentRun()) {
            return;
        }
        this.d.safePersist();
        // Include the stable logicalTurnId in the commit subject so `git log`
        // (and the timeline view) shows a durable, reopen-stable id per turn.
        void ledger.commitTurn(
            this.d.sessionId,
            `turn ${this.d.getTurnNo()} (${logicalTurnId}) — user→assistant (model=${this.d.model()})`,
        );
        void this.d.maybeAutoCompact();
        if (this.pendingTasksCompact) {
            this.pendingTasksCompact = false;
            void this.d.compactOnTasksComplete();
        }
        emitTurnEnd();
    }
}
