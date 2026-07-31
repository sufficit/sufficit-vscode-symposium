import { ChatMessage } from "./types";
import { filterTools, classifyTool, classifyLmTool, needsApproval } from "../aiTools";
import { isLmTool } from "../lmTools";
import * as ledger from "../../ledger";
import { toResponsesInput } from "./transform";
import { diffCounts, editDiff } from "../parse";
import { snapshots } from "../../snapshots";
import { friendlyToolDetail, toolPath } from "./toolDetail";
import { consumeStream } from "./streamConsume";
import { assessContextWindow, windowMessages, isWindowTruncated, estimateRequest, requestEstimateDiagnostic } from "./requestWindow";
import { compressMessages, CompressionManager, CompressionPreset } from "../../compression";
import { stripSourcePrefix } from "./toolMerge";
import { findToolHistoryIssues, materializeToolSafeHistory } from "./toolHistory";
import { makeAttemptId } from "./turnId";
import { buildTurnTools, executeTurnTool } from "./turnTools";
import { emitTurnUsage } from "./turnUsage";
import { guardrailStopNotice, REPEAT_TOOL_CALL_LIMIT, repeatedToolCallWithoutProgress } from "./turnNotices";
import { TurnRunnerDeps } from "./turnRunnerDeps";

export type { TurnRunnerDeps } from "./turnRunnerDeps";

/**
 * One conversation turn for an OpenAISession: the streaming tool-call loop that
 * POSTs the windowed history, consumes the SSE reply, runs any requested tools,
 * and round-trips until the model finishes (or a cap / guard stops it). Owns the
 * in-flight AbortController so a cancel reaches the live request. Extracted from
 * OpenAISession; all session state is reached through the deps bag.
 */
export class TurnRunner {
    private abort: AbortController | undefined;
    // Set when task_complete/TaskUpdate fires comfortably under the compaction
    // threshold (see the task_complete branch below): the actual compact runs
    // once this turn fully ends, alongside the existing post-turn auto-compact
    // fire-and-forget — never mid-loop, where it would race the tool loop still
    // appending to the same live `messages` array.
    private pendingTasksCompact = false;

    constructor(private readonly d: TurnRunnerDeps) { }

    /** Aborts the in-flight request (cancel / dispose / steer). */
    cancel(): void {
        this.abort?.abort();
    }

    async run(): Promise<void> {
        const messages = this.d.getMessages();
        const progress = this.d.getProgress();
        this.abort = new AbortController();
        // Assign a stable logicalTurnId for this turn (survives retries/reopen).
        // A Retry passes resumeTurnId so the adapter REUSES the original turn's id
        // instead of allocating a new one (delivery 1C).
        const logicalTurnId = this.d.resumeTurn(this.d.getResumeTurnId?.());
        const intentId = this.d.getIntentId();
        const turnStartedAt = Date.now();
        // turn-start pairs with turn-end below; carries the stable ids so the
        // render pipeline (renderStream/controllerTranscript) and any future
        // retry/redirect logic can associate deltas with the right turn.
        this.d.emit({ kind: "turn-start", logicalTurnId, ...(intentId ? { intentId } : {}) });
        const emitTurnEnd = () => this.d.emit({ kind: "turn-end", durationMs: Date.now() - turnStartedAt });
        const responses = this.d.cfg.api === "responses";
        const base = this.d.cfg.baseUrl.replace(/\/+$/, "");
        const url = base + (responses ? "/responses" : "/chat/completions");
        const effort = this.d.options.reasoning;
        let loginToken = await this.d.authToken();   // logged-in Bearer, if needed
        const compressionPresetId = this.d.options.compressionPresetId;
        let compressionPreset: CompressionPreset | undefined;
        let compressionNoticeEmitted = false;
        let compressionFailureEmitted = false;
        if (compressionPresetId && compressionPresetId !== "none") {
            compressionPreset = CompressionManager.getInstance().getPreset(compressionPresetId);
            if (!compressionPreset) {
                this.d.emit({ kind: "status-notice", text: `[Compression: preset "${compressionPresetId}" not found; continuing uncompressed]` });
            }
        }
        const requestMessages = (): ChatMessage[] => {
            if (!compressionPreset || !compressionPresetId) { return messages; }
            try {
                const compressed = compressMessages(messages, compressionPreset.strategy, compressionPreset.params);
                if (!compressionNoticeEmitted) {
                    this.d.emit({ kind: "status-notice", text: `[Compression: applied preset "${compressionPresetId}" - ${messages.length} → ${compressed.length} messages]` });
                    compressionNoticeEmitted = true;
                }
                return compressed;
            } catch (err) {
                if (!compressionFailureEmitted) {
                    this.d.emit({ kind: "error", message: `[Compression: failed to apply preset "${compressionPresetId}": ${err instanceof Error ? err.message : String(err)}` });
                    compressionFailureEmitted = true;
                }
                return messages;
            }
        };
        const noExplicitAuth = !this.d.cfg.apiKey
            && !Object.keys(this.d.cfg.headers).some((k) => k.toLowerCase() === "authorization");
        if (noExplicitAuth && !loginToken) {
            this.d.emit({ kind: "error", message: "Not authenticated: sign in to Sufficit (Accounts menu / avatar) to use the Sufficit AI backend. If you already signed in and the error persists, the token is not being stored in this environment (code-server without a keyring): set symposium.openai.apiKey or an Authorization header." });
            emitTurnEnd();
            return;
        }
        if (!this.d.model()) {
            await this.d.discoverModels(loginToken).catch(() => undefined);
        }
        if (!this.d.model()) {
            this.d.emit({ kind: "error", message: "No model selected for Sufficit AI. Pick a model in the session selector or set symposium.openai.model / symposium.openai.models." });
            emitTurnEnd();
            return;
        }
        const finalTools = buildTurnTools(this.d.hub.configured(), responses);

        const unlimited = this.d.options.autonomy === "away";
        const HARD_CAP = 200;
        const softCap = unlimited ? HARD_CAP : Math.max(1, this.d.cfg.maxToolHops ?? 50);
        const maxHops = Math.min(softCap, HARD_CAP);
        let hitCap = !unlimited;   // cleared when the model finishes on its own
        let toolHistoryMaterializationNoticeEmitted = false;
        const recentCalls: string[] = [];
        const noProgressStop = Math.max(0, this.d.cfg.noProgressStop ?? 0);
        let noTextHops = 0;
        try {
            for (let hop = 0; hop < maxHops; hop++) {
                this.abort = new AbortController();
                const currentMessages = requestMessages();
                const windowed = windowMessages(currentMessages, this.d.cfg.maxHistoryMessages ?? 40);
                const anchor = (isWindowTruncated(messages, this.d.cfg.maxHistoryMessages ?? 40) || hop >= 3) ? this.d.followupAnchor() : undefined;
                const materialized = materializeToolSafeHistory(
                    anchor ? [...windowed, anchor] : windowed,
                    this.d.cfg.supportsDeveloperRole !== false ? "developer" : "system",
                );
                const outMessages = materialized.messages;
                if (!toolHistoryMaterializationNoticeEmitted && (materialized.foldedOrphanTools > 0 || materialized.foldedMissingToolCalls > 0 || materialized.repairedMissingToolCalls > 0)) {
                    this.d.emit({ kind: "status-notice", text: `OpenAI request history materialized from saved session; persisted transcript unchanged. folded_orphan_tools=${materialized.foldedOrphanTools} folded_missing_tool_calls=${materialized.foldedMissingToolCalls} repaired_missing_tool_calls=${materialized.repairedMissingToolCalls}` });
                    toolHistoryMaterializationNoticeEmitted = true;
                }
                const toolHistoryIssues = findToolHistoryIssues(outMessages);
                if (toolHistoryIssues.length > 0) {
                    const orphanCount = toolHistoryIssues.filter((issue) => issue.type === "orphan_tool_message").length;
                    const missingCount = toolHistoryIssues.length - orphanCount;
                    this.d.emit({
                        kind: "status-notice",
                        text: `OpenAI dispatch history has invalid tool pairing; request sent unchanged. orphan_tools=${orphanCount} missing_tool_results=${missingCount}`,
                    });
                }
                const body: Record<string, unknown> = responses
                    ? { model: this.d.model(), input: toResponsesInput(outMessages), stream: true }
                    : { model: this.d.model(), messages: outMessages, stream: true, stream_options: { include_usage: true } };
                const allow = this.d.options.aiTools;
                const toolList = filterTools<{ function?: { name: string }; name?: string }>(
                    finalTools as { function?: { name: string }; name?: string }[], allow);
                if (toolList.length > 0) {
                    body.tools = toolList;
                    body.tool_choice = "auto";
                }
                if (effort && effort !== "default") {
                    if (responses) { body.reasoning = { effort }; }
                    else { body.reasoning_effort = effort; }
                }
                const bodyJson = JSON.stringify(body);
                const estimate = estimateRequest(bodyJson, outMessages.length, toolList.length);
                this.d.emitRequestEstimate(estimate);
                const contextAssessment = assessContextWindow(
                    estimate.inputTokens,
                    this.d.contextWindow(),
                    this.d.cfg.autoCompactAt,
                );
                if (contextAssessment.shouldCompact && await this.d.maybeAutoCompact(estimate.inputTokens)) {
                    // The compactor rewrote the live history. Rebuild this same
                    // hop from that smaller state before recording or sending
                    // anything; compaction must not consume a tool-hop budget.
                    hop--;
                    continue;
                }
                if (contextAssessment.exceedsWindow) {
                    const diagnostic = requestEstimateDiagnostic(estimate, this.d.contextWindow());
                    const autoState = (this.d.cfg.autoCompactAt ?? 0) > 0
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
                this.d.cfg.log?.(`[${this.d.backend}] POST ${url} api=${this.d.cfg.api} model=${this.d.model()} tools=${toolList.length} hop=${hop}`);
                // One attemptId per model POST (hop) within this logical turn, so a
                // multi-hop turn and a retried turn are distinguishable downstream.
                const attemptId = makeAttemptId(logicalTurnId, hop + 1);
                ledger.recordRequest(this.d.sessionId, body, attemptId);
                const requestStartedAt = Date.now();
                const signal = this.abort.signal;
                const post = (token: string | null | undefined) => fetch(url, { method: "POST", headers: this.d.headers(token), body: bodyJson, signal });
                let res = await post(loginToken);
                if (res.status === 401 && noExplicitAuth && loginToken) {
                    this.d.emit({ kind: "status-notice", text: "Sufficit AI authorization refreshed; retrying once." });
                    loginToken = await this.d.authToken(true);
                    if (loginToken) { res = await post(loginToken); }
                }
                const responseStartedAt = Date.now();
                if (!res.ok || !res.body) {
                    const detail = await res.text().catch(() => "");
                    const diagnostic = requestEstimateDiagnostic(estimate, this.d.contextWindow());
                    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
                    this.d.emit({ kind: "error", message: `HTTP ${res.status} ${res.statusText} ${detail}\n${diagnostic}`.trim(), retryable });
                    hitCap = false;
                    break;
                }
                const m = this.d.model();
                const { text, reasoning, toolCalls, aborted, usage } = await consumeStream(res.body, m, { requestStartedAt, responseStartedAt }, responses, {
                    onText: (delta) => this.d.emit({ kind: "text", text: delta, model: m, modelLabel: this.d.label(m) }),
                    onReasoning: (delta) => this.d.emit({ kind: "thinking", text: delta }),
                    onError: (message) => this.d.emit({ kind: "error", message }), onStatusNotice: (notice) => this.d.emit({ kind: "status-notice", text: notice }),
                });

                if (usage) { emitTurnUsage(this.d, usage); }

                await this.d.maybeAutoCompact();

                if (aborted) {
                    if (toolCalls.length > 0) {
                        messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
                        if (text) { this.d.led("assistant", text); }
                        // Satisfy the API contract: every tool_call needs a tool reply.
                        for (const tc of toolCalls) {
                            messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: "(interrupted before execution)" });
                        }
                    } else if (text) {
                        messages.push({ role: "assistant", content: text, model: this.d.model() });
                        this.d.led("assistant", text);
                    }
                    hitCap = false;
                    break;
                }

                if (toolCalls.length === 0) {
                    messages.push({ role: "assistant", content: text || "", model: this.d.model() });
                    if (text) { this.d.led("assistant", text); }
                    if (!text.trim() && !reasoning.trim()) {
                        this.d.emit({ kind: "status-notice", text: "The model returned an empty response (no content). Try resending, a different model, or a lower reasoning effort." });
                    }
                    hitCap = false;
                    break;
                }

                if (noProgressStop > 0) {
                    if (text.trim()) { noTextHops = 0; } else { noTextHops++; }
                    if (noTextHops === Math.ceil(noProgressStop / 2)) {
                        const nudgeRole = this.d.cfg.supportsDeveloperRole !== false ? "developer" : "system";
                        messages.push({ role: nudgeRole, content: "[Convergence] You have run several tools in a row without replying. If you already have enough information, STOP calling tools and answer now; otherwise take only the single next necessary step." });
                    }
                    if (noTextHops >= noProgressStop) {
                        this.d.emit(guardrailStopNotice(
                            `Stopped after ${noTextHops} tool steps without a reply. Send "continue" to resume.`,
                        ));
                        hitCap = false;
                        break;
                    }
                }

                const sig = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).join("|");
                if (repeatedToolCallWithoutProgress(recentCalls, sig)) {
                    this.d.emit(guardrailStopNotice(
                        `Stopped because the model repeated the same tool call ${REPEAT_TOOL_CALL_LIMIT} times without progress.`,
                    ));
                    hitCap = false;
                    break;
                }
                messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
                if (text) { this.d.led("assistant", text); }
                this.d.safePersist();
                for (const tc of toolCalls) {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* leave empty */ }
                    const unprefixedName = stripSourcePrefix(tc.function.name);
                    const counts = diffCounts(unprefixedName, args);
                    const editPath = counts ? this.d.resolveToolPath(args.path) : undefined;
                    if (counts && editPath && this.d.sessionId) {
                        snapshots.capture(this.d.sessionId, editPath);
                    }
                    this.d.emit({
                        kind: "tool-start",
                        toolName: unprefixedName,
                        detail: friendlyToolDetail(unprefixedName, args),
                        path: editPath ?? toolPath(unprefixedName, args),
                        added: counts?.added,
                        removed: counts?.removed,
                        diff: editDiff(unprefixedName, args),
                        toolId: tc.id,
                        input: tc.function.arguments,
                    });
                    const isLm = isLmTool(unprefixedName);
                    const tier = isLm ? classifyLmTool(unprefixedName) : classifyTool(unprefixedName);
                    let result: string;
                    // Shell escape guardrail (defect 6.1): the write-root containment
                    // checks only the shell's cwd, NOT the command — so a shell is an
                    // escape hatch when roots are set (redirection, git -C, curl|sh).
                    // When containment is active, force approval for destructive tools
                    // (shell) — BUT only in non-admin modes. Admin mode means the user
                    // explicitly opted into no gates; the containment is still enforced
                    // for the file tools (write_file/edit_file), which check roots
                    // unconditionally. Shell is advisory in admin.
                    const containmentActive = Array.isArray(this.d.options.allowedWriteRoots) && this.d.options.allowedWriteRoots.length > 0;
                    const isAdmin = this.d.options.permission === "admin";
                    const requiresApproval = tier !== "read" && (needsApproval(this.d.options.permission, tier) || (tier === "destructive" && containmentActive && !isAdmin));
                    if (requiresApproval) {
                        const approved = await this.d.requestApproval(tc.id, unprefixedName, friendlyToolDetail(unprefixedName, args), tier);
                        result = approved
                            ? await executeTurnTool({ name: unprefixedName, input: args, toolId: tc.id, hub: this.d.hub, options: this.d.options, sessionId: this.d.sessionId, backend: this.d.backend, shellMode: this.d.shellExecutionMode(), abortSignal: this.abort?.signal, emit: this.d.emit })
                            : JSON.stringify({ error: "User denied this action." });
                    } else {
                        result = await executeTurnTool({ name: unprefixedName, input: args, toolId: tc.id, hub: this.d.hub, options: this.d.options, sessionId: this.d.sessionId, backend: this.d.backend, shellMode: this.d.shellExecutionMode(), abortSignal: this.abort?.signal, emit: this.d.emit });
                    }
                    this.d.emit({ kind: "tool-end", toolName: unprefixedName, toolId: tc.id, result });
                    messages.push({ role: "tool", tool_call_id: tc.id, name: unprefixedName, content: result });
                    this.d.led("tool", result, { name: unprefixedName, detail: friendlyToolDetail(unprefixedName, args) });
                    const step = friendlyToolDetail(unprefixedName, args);
                    progress.push((unprefixedName + (step ? " — " + step : "")).slice(0, 110));
                    if (progress.length > 60) { progress.shift(); }
                    this.d.safePersist();   // each completed tool round is durable immediately
                    if (unprefixedName === "task_complete" || unprefixedName === "TaskUpdate") {
                        let parsedResult: { allTasksComplete?: boolean } | null = null;
                        try { parsedResult = JSON.parse(result); } catch { /* not JSON, ignore */ }
                        if (parsedResult?.allTasksComplete) {
                            const at = this.d.cfg.autoCompactAt ?? 0;
                            const win = this.d.contextWindow();
                            const used = win > 0 ? this.d.getLastInputTokens() / win : 0;
                            if (at > 0 && used >= at) {
                                this.d.emit({ kind: "status-notice", text: `All tasks complete — context is at ${Math.round(used * 100)}% of the window, compacting now before continuing.` });
                                await this.d.compactOnTasksComplete();
                            } else {
                                this.d.emit({ kind: "status-notice", text: "All tasks complete — compacting context in the background once this turn ends." });
                                this.pendingTasksCompact = true;
                            }
                        }
                    }
                }
                // loop again so the model can use the tool results
            }
            if (hitCap) {
                this.d.emit({ kind: "text", text: `\n\n_(paused after ${maxHops} tool steps — send "continue" to proceed)_` });
            }
        } catch (error) {
            if ((error as { name?: string })?.name !== "AbortError") {
                const msg = error instanceof Error ? error.message : String(error);
                // Network/transport failures (DNS, connection reset, timeout,
                // "fetch failed", "terminated") are transient and safe to retry
                // with the exact same request — unlike a 4xx or a logic error.
                const retryable = /fetch failed|network error|network request failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|EPROTO|EPIPE|socket hang up|terminated|aborted|timeout|request timed out|connection refused|connection reset|getaddrinfo/i.test(msg);
                this.d.emit({ kind: "error", message: msg, retryable });
            }
        }
        this.d.safePersist();
        // Include the stable logicalTurnId in the commit subject so `git log`
        // (and the timeline view) shows a durable, reopen-stable id per turn.
        void ledger.commitTurn(this.d.sessionId, `turn ${this.d.getTurnNo()} (${logicalTurnId}) — user→assistant (model=${this.d.model()})`);
        void this.d.maybeAutoCompact();
        if (this.pendingTasksCompact) {
            this.pendingTasksCompact = false;
            void this.d.compactOnTasksComplete();
        }
        emitTurnEnd();
    }
}
