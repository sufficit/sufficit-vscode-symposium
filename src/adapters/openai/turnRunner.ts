import { ChatMessage, OpenAIAdapterConfig } from "./types";
import { SessionStartOptions } from "../types";
import { HubClient } from "../../sync/hubClient";
import {
    AI_TOOLS, AI_TOOLS_RESPONSES, LOCAL_TOOLS, LOCAL_TOOLS_RESPONSES,
    SUBAGENT_TOOLS, SUBAGENT_TOOLS_RESPONSES, getSubagentHost,
    filterTools, runAiTool, ShellExecutionMode,
} from "../aiTools";
import { lmToolDefs, lmToolDefsResponses, isLmTool, invokeLmTool } from "../lmTools";
import * as ledger from "../../ledger";
import { toResponsesInput } from "./transform";
import { diffCounts, editDiff } from "../parse";
import { snapshots } from "../../snapshots";
import { friendlyToolDetail, toolPath } from "./toolDetail";
import { consumeStream } from "./streamConsume";
import {
    RequestEstimate, windowMessages, isWindowTruncated, estimateRequest, requestEstimateDiagnostic,
} from "./requestWindow";
import { compressMessages, CompressionManager } from "../../compression";

/**
 * Strip source prefix from tool name (sym_, local_, agent_, vscode_).
 * Added by turnRunner to resolve name collisions across tool sources.
 */
function stripSourcePrefix(name: string): string {
    const prefixMatch = name.match(/^(sym_|local_|agent_|vscode_)(.*)$/);
    return prefixMatch ? prefixMatch[2] : name;
}

/**
 * One conversation turn for an OpenAISession: the streaming tool-call loop that
 * POSTs the windowed history, consumes the SSE reply, runs any requested tools,
 * and round-trips until the model finishes (or a cap / guard stops it). Owns the
 * in-flight AbortController so a cancel reaches the live request. Extracted from
 * OpenAISession; all session state is reached through the deps bag.
 */
export interface TurnRunnerDeps {
    cfg: OpenAIAdapterConfig;
    options: SessionStartOptions;
    sessionId: string;
    backend: string;
    hub: HubClient;
    /** Live message array — appended to as the turn progresses. */
    getMessages: () => ChatMessage[];
    /** Live continuous-follow-up progress digest — pushed to per tool step. */
    getProgress: () => string[];
    bumpTurnNo: () => void;
    getTurnNo: () => number;
    getLastInputTokens: () => number;
    setLastInputTokens: (n: number) => void;
    emit: (event: Record<string, unknown>) => void;
    model: () => string;
    label: (id: string) => string;
    contextWindow: () => number;
    headers: (loginToken?: string | null) => Record<string, string>;
    authToken: () => Promise<string | null>;
    discoverModels: (loginToken?: string | null) => Promise<void>;
    followupAnchor: () => ChatMessage | undefined;
    emitRequestEstimate: (estimate: RequestEstimate) => void;
    shellExecutionMode: () => ShellExecutionMode;
    resolveToolPath: (p: unknown) => string | undefined;
    safePersist: () => void;
    led: (role: string, content: unknown, extra?: Record<string, unknown>) => void;
    maybeAutoCompact: () => void;
}

export class TurnRunner {
    private abort: AbortController | undefined;

    constructor(private readonly d: TurnRunnerDeps) { }

    /** Aborts the in-flight request (cancel / dispose / steer). */
    cancel(): void {
        this.abort?.abort();
    }

    async run(): Promise<void> {
        const messages = this.d.getMessages();
        const progress = this.d.getProgress();
        this.abort = new AbortController();
        this.d.bumpTurnNo();   // each run() is one conversation turn (ledger turn index)
        const turnStartedAt = Date.now();
        const emitTurnEnd = () => this.d.emit({ kind: "turn-end", durationMs: Date.now() - turnStartedAt });
        const responses = this.d.cfg.api === "responses";
        const base = this.d.cfg.baseUrl.replace(/\/+$/, "");
        const url = base + (responses ? "/responses" : "/chat/completions");
        const effort = this.d.options.reasoning;
        const loginToken = await this.d.authToken();   // logged-in Bearer, if needed
        // Apply compression if configured
        const compressionPresetId = this.d.options.compressionPresetId;
        let workingMessages = messages;
        if (compressionPresetId && compressionPresetId !== "none") {
            try {
                const preset = CompressionManager.getInstance().getPreset(compressionPresetId);
                if (preset) {
                    workingMessages = compressMessages(messages, preset.strategy, preset.params);
                    this.d.emit({ kind: "info", message: `[Compression: applied preset "${compressionPresetId}" - ${messages.length} → ${workingMessages.length} messages]` });
                } else {
                    this.d.emit({ kind: "warn", message: `[Compression: preset "${compressionPresetId}" not found]` });
                }
            } catch (err) {
                this.d.emit({ kind: "error", message: `[Compression: failed to apply preset "${compressionPresetId}": ${err instanceof Error ? err.message : String(err)}` });
                workingMessages = messages; // fallback to original messages
            }
        }
        // Auth guard: when the gateway has no explicit apiKey/Authorization
        // configured, it relies on the logged-in Sufficit token. If that token
        // is missing (not logged in, or the token didn't persist — e.g. a
        // code-server without a system keyring), fail early with a clear
        // message instead of sending an unauthenticated request that the
        // gateway answers with a cryptic HTTP 401.
        const noExplicitAuth = !this.d.cfg.apiKey
            && !Object.keys(this.d.cfg.headers).some((k) => k.toLowerCase() === "authorization");
        if (noExplicitAuth && !loginToken) {
            this.d.emit({ kind: "error", message: "Not authenticated: sign in to Sufficit (Accounts menu / avatar) to use the Sufficit AI backend. If you already signed in and the error persists, the token is not being stored in this environment (code-server without a keyring): set symposium.openai.apiKey or an Authorization header." });
            emitTurnEnd();
            return;
        }
        // Model guard: never POST with an empty model (the gateway 400s). Try a
        // best-effort discovery from <baseUrl>/models first; if still empty,
        // tell the user to pick/configure a model instead of failing obscurely.
        if (!this.d.model()) {
            await this.d.discoverModels(loginToken).catch(() => undefined);
        }
        if (!this.d.model()) {
            this.d.emit({ kind: "error", message: "No model selected for Sufficit AI. Pick a model in the session selector or set symposium.openai.model / symposium.openai.models." });
            emitTurnEnd();
            return;
        }
        // Tools exposed to the model: local shell/filesystem tools (always — the
        // parity with the CLI backends) plus memory/web tools when the hub is
        // configured. The model calls them; we execute and feed results back.
        const memoryTools = this.d.hub.configured()
            ? (responses ? AI_TOOLS_RESPONSES : AI_TOOLS)
            : [];
        const localTools = responses ? LOCAL_TOOLS_RESPONSES : LOCAL_TOOLS;
        // Subagent orchestration tools — only when the live runtime is available
        // (a SubagentHost is set), so a headless/test session never offers them.
        const subagentTools = getSubagentHost() ? (responses ? SUBAGENT_TOOLS_RESPONSES : SUBAGENT_TOOLS) : [];
        // VS Code Language Model Tools (runInTerminal, runTask, runTests, …):
        // computed fresh each turn so registry/setting changes take effect.
        const vscodeTools = responses ? lmToolDefsResponses() : lmToolDefs();

        // Tool name collision handling: prefix source for tools with same name
        // but different descriptions; deduplicate only if name+description match.
        // Sources: sym_ (memory), local_ (local), agent_ (subagent), vscode_ (VS Code LM)
        const allTools = [
            ...memoryTools.map((t) => ({ tool: t, source: "sym_" })),
            ...localTools.map((t) => ({ tool: t, source: "local_" })),
            ...subagentTools.map((t) => ({ tool: t, source: "agent_" })),
            ...vscodeTools.map((t) => ({ tool: t, source: "vscode_" })),
        ];
        interface ToolDefinition {
            name?: string;
            function?: {
                name: string;
                description?: string;
            };
            description?: string;
        }
        const nameGroups = new Map<string, { tool: ToolDefinition; source: string }[]>();
        for (const { tool, source } of allTools) {
            const t = tool as ToolDefinition;
            const name = (t.function?.name ?? t.name) as string;
            if (!nameGroups.has(name)) { nameGroups.set(name, []); }
            nameGroups.get(name)!.push({ tool, source });
        }
        const finalTools: { tool: ToolDefinition; source: string }[] = [];
        for (const group of nameGroups.values()) {
            const t0 = group[0].tool as ToolDefinition;
            const firstDesc = t0.function?.description ?? t0.description;
            const allSameDesc = group.every((g) => {
                const tg = g.tool as ToolDefinition;
                return (tg.function?.description ?? tg.description) === firstDesc;
            });
            if (allSameDesc) {
                // Deduplicate: keep only one (any source, descriptions match)
                finalTools.push(group[0]);
            } else {
                // Prefix source to avoid collision
                for (const { tool, source } of group) {
                    const nameKey = (tool.function?.name ?? tool.name) as string;
                    if (tool.function) {
                        tool.function = { ...tool.function, name: `${source}${nameKey}` };
                        tool.function.description = `[${source.slice(0, -1)}] ${tool.function.description ?? ""}`;
                    } else if (tool.name) {
                        tool.name = `${source}${nameKey}`;
                        tool.description = `[${source.slice(0, -1)}] ${tool.description}`;
                    }
                    finalTools.push({ tool, source });
                }
            }
        }

        // How many tool round-trips one turn may run before pausing. In
        // autonomous mode (presence "away") there is NO limit; otherwise the
        // configurable cap applies (default 50) so it pauses for "continue".
        const unlimited = this.d.options.autonomy === "away";
        // Even in unlimited (autonomy) mode keep an absolute hard ceiling so a
        // runaway tool loop can never wedge the turn forever (busy stuck).
        const HARD_CAP = 200;
        const softCap = unlimited ? HARD_CAP : Math.max(1, this.d.cfg.maxToolHops ?? 50);
        const maxHops = Math.min(softCap, HARD_CAP);
        let hitCap = !unlimited;   // cleared when the model finishes on its own
        // Loop guard: if the model repeats the exact same tool+args many times
        // in a row without progress, break out instead of spinning forever.
        const recentCalls: string[] = [];
        const REPEAT_LIMIT = 6;
        // Optional anti-loop: stop the turn after N consecutive tool-only rounds
        // (no assistant reply). Off by default (0); user-set in Preferences.
        const noProgressStop = Math.max(0, this.d.cfg.noProgressStop ?? 0);
        let noTextHops = 0;
        try {
            // Tool-call loop: keep round-tripping while the model requests tools.
            for (let hop = 0; hop < maxHops; hop++) {
                this.abort = new AbortController();
                const windowed = windowMessages(workingMessages, this.d.cfg.maxHistoryMessages ?? 40);
                // Continuous follow-up: once history is being windowed out (or after
                // a few hops into the tool-loop), append a fresh objective+progress
                // anchor at the tail so a small-context model keeps the thread.
                const anchor = (isWindowTruncated(messages, this.d.cfg.maxHistoryMessages ?? 40) || hop >= 3) ? this.d.followupAnchor() : undefined;
                const outMessages = anchor ? [...windowed, anchor] : windowed;
                const body: Record<string, unknown> = responses
                    ? { model: this.d.model(), input: toResponsesInput(outMessages), stream: true }
                    : { model: this.d.model(), messages: outMessages, stream: true, stream_options: { include_usage: true } };
                // Gate by the bound agent-def's allowlist (options.aiTools); when
                // unset, expose all; when set to [], expose none (tools off).
                const allow = this.d.options.aiTools;
                const toolList = filterTools<{ function?: { name: string }; name?: string }>(
                    finalTools.map((ft) => ft.tool) as { function?: { name: string }; name?: string }[], allow);
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
                this.d.cfg.log?.(`[${this.d.backend}] POST ${url} api=${this.d.cfg.api} model=${this.d.model()} tools=${toolList.length} hop=${hop}`);
                // Ledger audit: record the LITERAL request body (truth of what the
                // LLM received this hop) — feeds the "Request" inspection view.
                ledger.recordRequest(this.d.sessionId, body);
                const requestStartedAt = Date.now();
                const res = await fetch(url, {
                    method: "POST", headers: this.d.headers(loginToken), body: bodyJson, signal: this.abort.signal,
                });
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
                const { text, toolCalls, aborted, usage } = await consumeStream(res.body, m, { requestStartedAt, responseStartedAt }, responses, {
                    onText: (delta) => this.d.emit({ kind: "text", text: delta, model: m, modelLabel: this.d.label(m) }),
                    onError: (message) => this.d.emit({ kind: "error", message }),
                    onStatusNotice: (notice) => this.d.emit({ kind: "status-notice", text: notice }),
                });

                // Context monitor: report token usage for this request. inputTokens
                // is the prompt size = the live context the model just saw, so the
                // meter tracks "context used / window" like the CLI backends.
                if (usage && (usage.inputTokens || usage.outputTokens)) {
                    this.d.setLastInputTokens(usage.inputTokens || this.d.getLastInputTokens());
                    this.d.emit({
                        kind: "usage",
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        totalTokens: usage.totalTokens,
                        reasoningTokens: usage.reasoningTokens,
                        cacheRead: usage.cacheRead,
                        contextWindow: this.d.contextWindow(),
                        model: usage.model,
                        modelLabel: usage.model ? this.d.label(usage.model) : undefined,
                        providerKey: usage.providerKey,
                        providerType: usage.providerType,
                        requestedModel: usage.requestedModel,
                        attempts: usage.attempts,
                        fallbackAttempts: usage.fallbackAttempts,
                        compression: usage.compression,
                        durationMs: usage.durationMs,
                        ttfbMs: usage.ttfbMs,
                        firstDeltaMs: usage.firstDeltaMs,
                    });
                }

                // Stream paused/interrupted mid-turn: keep the partial assistant
                // reply (and any partial tool calls) in history so context is not
                // lost on the next message, then stop this turn.
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
                    // Always record an assistant turn, even when the model returned
                    // empty text (reasoning-only / empty content). Skipping it leaves
                    // a dangling user/developer turn; Anthropic-backed gateways then
                    // 400 on the next message because roles no longer alternate.
                    messages.push({ role: "assistant", content: text || "", model: this.d.model() });
                    if (text) { this.d.led("assistant", text); }
                    hitCap = false;
                    break;
                }

                // Optional no-progress stop (Preferences). Count consecutive
                // tool-only rounds; nudge near the limit, stop at it.
                if (noProgressStop > 0) {
                    if (text.trim()) { noTextHops = 0; } else { noTextHops++; }
                    if (noTextHops === Math.ceil(noProgressStop / 2)) {
                        const nudgeRole = this.d.cfg.supportsDeveloperRole !== false ? "developer" : "system";
                        messages.push({ role: nudgeRole, content: "[Convergence] You have run several tools in a row without replying. If you already have enough information, STOP calling tools and answer now; otherwise take only the single next necessary step." });
                    }
                    if (noTextHops >= noProgressStop) {
                        this.d.emit({ kind: "text", text: `\n\n_(stopped after ${noTextHops} tool steps with no reply — send "continue" to resume)_` });
                        hitCap = false;
                        break;
                    }
                }

                // Record the assistant turn that requested tools, then run each.
                messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
                if (text) { this.d.led("assistant", text); }
                // Persist mid-turn: a window reload restarts the extension host
                // and wipes the in-memory render log, so only what's on disk
                // survives. Without this, reloading while tools run loses the
                // whole in-progress turn back to the last user message.
                this.d.safePersist();
                // Loop guard: detect the model spinning on the same call(s).
                const sig = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).join("|");
                recentCalls.push(sig);
                if (recentCalls.length > REPEAT_LIMIT) { recentCalls.shift(); }
                if (recentCalls.length === REPEAT_LIMIT && recentCalls.every((c) => c === sig)) {
                    this.d.emit({ kind: "text", text: `\n\n_(stopped: the model repeated the same tool call ${REPEAT_LIMIT}x without progress)_` });
                    hitCap = false;
                    break;
                }
                for (const tc of toolCalls) {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* leave empty */ }
                    // File-edit tools (write_file/edit_file): track like the Claude
                    // CLI's Write/Edit — snapshot the pre-edit content (revert) and
                    // emit added/removed + a diff so the change shows in the
                    // changed-files panel. This is why these are preferred over sed.
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
                    const shellMode = this.d.shellExecutionMode();
                    const progressCbs = {
                        onData: (chunk: string) => this.d.emit({ kind: "tool-output", toolName: unprefixedName, toolId: tc.id, text: chunk }),
                        onTerminal: (terminalName: string) => this.d.emit({ kind: "tool-start", toolName: unprefixedName, detail: `watching in terminal: ${terminalName}`, toolId: tc.id, terminalName }),
                        onNotify: (message: string) => this.d.emit({ kind: "tool-output", toolName: unprefixedName, toolId: tc.id, text: `\n[notify] ${message}\n` }),
                    };
                    const result = isLmTool(unprefixedName)
                        ? await invokeLmTool(unprefixedName, args)
                        : await runAiTool(unprefixedName, args, { hub: this.d.hub, cwd: this.d.options.cwd, permission: this.d.options.permission, sessionId: this.d.sessionId, shellExecution: shellMode, progress: progressCbs, parentBackend: this.d.backend, subagents: getSubagentHost() });
                    this.d.emit({ kind: "tool-end", toolName: unprefixedName, toolId: tc.id, result });
                    messages.push({ role: "tool", tool_call_id: tc.id, name: unprefixedName, content: result });
                    // Ledger (lossless): record the tool call + its result so the full
                    // transcript and read_session survive context compaction.
                    this.d.led("tool", result, { name: unprefixedName, detail: friendlyToolDetail(unprefixedName, args) });
                    // Feed the continuous-follow-up digest (one compact line per step).
                    const step = friendlyToolDetail(unprefixedName, args);
                    progress.push((unprefixedName + (step ? " — " + step : "")).slice(0, 110));
                    if (progress.length > 60) { progress.shift(); }
                    this.d.safePersist();   // each completed tool round is durable immediately
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
        // One immutable ledger commit per turn — the lossless snapshot the Chat
        // mirror and read_session read from, and the safety net under /compact.
        void ledger.commitTurn(this.d.sessionId, `turn ${this.d.getTurnNo()} — user→assistant (model=${this.d.model()})`);
        // Auto-compaction: if the context crossed the threshold this turn, fold it
        // before the next send (lazy, so it never delays this turn-end).
        this.d.maybeAutoCompact();
        emitTurnEnd();
    }
}
