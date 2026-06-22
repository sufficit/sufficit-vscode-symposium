import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AgentSession, SessionStartOptions } from "../types";
import { contextWindowFor, diffCounts, editDiff, mimeTypeFor } from "../parse";
import { snapshots } from "../../snapshots";
import { HubClient } from "../../sync/hubClient";
import {
    AI_TOOLS, AI_TOOLS_RESPONSES, LOCAL_TOOLS, LOCAL_TOOLS_RESPONSES,
    ALL_AI_TOOL_NAMES, filterTools, runAiTool, ShellExecutionMode,
} from "../aiTools";
import { lmToolDefs, lmToolDefsResponses, isLmTool, invokeLmTool } from "../lmTools";
import * as ledger from "../../ledger";
import { ApiUsage, ChatMessage, ContentPart, OpenAIAdapterConfig, ToolCall } from "./types";
import { readStored, writeStored } from "./store";
import { contentText, toResponsesInput } from "./transform";
import {
    getDiscoveredContext, getDiscoveredLabels, getDiscoveredModels,
    modelContextLength, setDiscovered,
} from "./models";
import { friendlyToolDetail, toolPath } from "./toolDetail";
import { getOpenAITokenProvider } from "./token";

/**
 * A direct OpenAI-compatible chat session (no CLI): streams /chat/completions
 * over HTTP with a custom base URL + headers, to talk straight to sufficit-ai
 * models. Stateless server-side, so history is kept here and persisted to disk
 * so the session survives a reload (the API has no transcript of its own).
 */
export class OpenAISession extends EventEmitter implements AgentSession {
    readonly sessionId: string;
    private readonly messages: ChatMessage[] = [];
    private abort: AbortController | undefined;
    private title = "";
    private readonly hub = new HubClient();
    private turnNo = 0;
    // Continuous follow-up anchor (small-context guardrail). `objective` is the
    // current task (north star), updated on each substantive user turn; `progress`
    // is a rolling digest of tool steps taken on it. Re-injected fresh into every
    // windowed request so the model can't lose the thread mid tool-loop.
    private objective = "";
    private progress: string[] = [];
    // Compaction state: last reported prompt size (for the auto-compact threshold)
    // and a guard so two compactions never overlap.
    private lastInputTokens = 0;
    private compacting = false;

    constructor(
        readonly backend: string,
        private readonly cfg: OpenAIAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        // Resume a stored session if asked, else start a fresh one.
        const resumed = options.resumeSessionId ? readStored(backend, options.resumeSessionId) : undefined;
        this.sessionId = resumed?.id ?? randomUUID();
        if (resumed) {
            this.messages.push(...resumed.messages); this.title = resumed.title;
            // Restore the model last used in this session (unless the caller
            // explicitly overrode it), so reopening keeps the same model.
            if (!this.options.model && resumed.model) { this.options.model = resumed.model; }
        } else {
            if (options.systemPrompt) {
                this.messages.push({ role: "system", content: options.systemPrompt });
            }
            if (options.developerPrompt) {
                const developerRole = this.cfg.supportsDeveloperRole !== false;
                this.messages.push({
                    role: developerRole ? "developer" : "system",
                    content: options.developerPrompt,
                });
            }
        }
        // Initialise the lossless git-backed ledger for this session and seed
        // it with any resumed messages (best-effort; never blocks the session).
        void ledger.ensureLedger(this.sessionId, this.ledgerMeta()).then(() => {
            if (resumed && !ledger.readMessages(this.sessionId).length) {
                for (const m of this.messages) {
                    ledger.appendMessage(this.sessionId, { role: m.role, content: m.content, turn: 0 });
                }
                void ledger.commitTurn(this.sessionId, "resume — seeded from store");
            }
        });
        queueMicrotask(() => this.emit("event", { kind: "session", sessionId: this.sessionId, model: this.model() }));
    }

    private persist(): void {
        writeStored({
            id: this.sessionId, backend: this.backend, title: this.title,
            cwd: this.options.cwd, model: this.model(), updatedAt: new Date().toISOString(),
            messages: this.messages,
        });
    }

    private safePersist(): void {
        try {
            this.persist();
        } catch (error) {
            this.emit("event", { kind: "error", message: `failed to persist session: ${error instanceof Error ? error.message : String(error)}` });
        }
    }

    private ledgerMeta(): import("../../ledger").LedgerMeta {
        return {
            id: this.sessionId, backend: this.backend, title: this.title,
            cwd: this.options.cwd, model: this.model(),
            reasoning: this.options.reasoning,
        };
    }

    private model(): string {
        // Never invent a foreign default (e.g. gpt-4o-mini): fall back to the
        // discovered models for this gateway, then empty (the user's picked model
        // is applied per-message before send).
        return this.options.model || this.cfg.model || this.cfg.models[0]
            || getDiscoveredModels(this.cfg.baseUrl)?.[0] || "";
    }

    /** Friendly name for a model id, from discovery (falls back to the id). */
    private label(id: string): string {
        if (!id) { return ""; }
        return getDiscoveredLabels(this.cfg.baseUrl)?.[id] ?? id;
    }

    /**
     * Context window (tokens) for the active model, feeding the context monitor.
     * Prefers the value the gateway's /models catalog advertised; falls back to
     * the model-name heuristic (200k default, 1m variants) so the meter shows
     * even before discovery resolves.
     */
    private contextWindow(): number {
        const id = this.model();
        return getDiscoveredContext(this.cfg.baseUrl)?.[id] || contextWindowFor(id);
    }

    /**
     * Sliding-window view of this.messages for outbound requests.
     *
     * Always keeps:
     *   1. The system/developer prefix (session init prompts + one-shot preambles).
     *   2. The first user message (anchor that triggered those preambles).
     *   3. Up to maxHistoryMessages of the most recent conversation tail.
     *
     * The full array is preserved in this.messages for persistence/ledger.
     */
    private windowedMessages(): ChatMessage[] {
        const max = this.cfg.maxHistoryMessages ?? 40;
        if (max === 0) { return this.messages; }

        // Protect ONLY the system/developer preamble (policy, agent def, etc.) —
        // everything before the first user message. Do NOT pin the first user
        // message: in a long, multi-task session that permanently re-injects the
        // ORIGINAL task into every request, so the model keeps drifting back to
        // it ("changed course mid-task"). The recent window carries the task in
        // progress; for short sessions the first message is still in-window.
        const firstUserIdx = this.messages.findIndex((m) => m.role === "user");
        if (firstUserIdx === -1) { return this.messages; }

        const prefix = this.messages.slice(0, firstUserIdx);
        const conv = this.messages.slice(firstUserIdx);

        if (conv.length <= max) { return this.messages; }
        return [...prefix, ...conv.slice(conv.length - max)];
    }

    /** True when the sliding window is dropping older turns (so the raw task /
     *  earlier steps are no longer in the request — when the anchor matters). */
    private windowTruncated(): boolean {
        const max = this.cfg.maxHistoryMessages ?? 40;
        if (max === 0) { return false; }
        const firstUserIdx = this.messages.findIndex((m) => m.role === "user");
        if (firstUserIdx === -1) { return false; }
        return (this.messages.length - firstUserIdx) > max;
    }

    /**
     * Continuous follow-up: a compact OBJECTIVE + PROGRESS + convergence block,
     * appended to the TAIL of a windowed request (highest-attention position) so a
     * small-context model keeps the thread across a long tool-loop. Request-only —
     * never pushed into this.messages, so it stays fresh and doesn't bloat history.
     */
    private followupAnchor(): ChatMessage | undefined {
        if (!this.objective) { return undefined; }
        const lines: string[] = [
            "[Continuous focus — your context window is small, so treat THIS as the source of truth for the current task]",
            "OBJECTIVE: " + this.objective,
        ];
        if (this.progress.length) {
            const recent = this.progress.slice(-6);
            lines.push(`PROGRESS so far (${this.progress.length} steps; last ${recent.length}):`);
            for (const p of recent) { lines.push("  • " + p); }
        }
        lines.push("GUIDANCE: Every tool call must move the OBJECTIVE forward — if a step doesn't, stop and reconsider. The moment the objective is met, STOP calling tools and reply to the user. If you've taken several steps without replying, lead your next message with a one-line status.");
        const role = this.cfg.supportsDeveloperRole !== false ? "developer" : "system";
        return { role, content: lines.join("\n") };
    }

    /** Auto-compaction: fold the context when the last prompt crossed the
     *  configured fraction of the window. Lazy (runs after turn-end). */
    private maybeAutoCompact(): void {
        const at = this.cfg.autoCompactAt ?? 0;
        if (at <= 0 || this.compacting) { return; }
        const win = this.contextWindow();
        if (!win || !this.lastInputTokens) { return; }
        if (this.lastInputTokens / win >= at) { void this.compact("auto"); }
    }

    /**
     * Summarize the middle of the conversation into ONE synthetic message and
     * rewrite this.messages = prefix + summary + verbatim tail. The raw turns
     * stay in the ledger (lossless), tool results become pointers (recover via
     * read_session), and a `kind:"compaction"` marker is committed. Fail-safe:
     * any error leaves the context untouched (windowing still applies).
     */
    private async compact(reason: "manual" | "auto"): Promise<void> {
        if (this.compacting) { return; }
        this.compacting = true;
        const note = (t: string) => this.emit("event", { kind: "text", text: `\n_(${t})_\n` });
        try {
            const keepTurns = 6;
            const firstUserIdx = this.messages.findIndex((m) => m.role === "user");
            if (firstUserIdx === -1) {
                if (reason === "manual") { note("nothing to compact yet"); }
                return;
            }
            let prefix = this.messages.slice(0, firstUserIdx);
            const conv = this.messages.slice(firstUserIdx);
            if (conv.length <= keepTurns + 2) {
                if (reason === "manual") { note("conversation is short — nothing to compact yet"); }
                return;
            }
            // Idempotent: a prior summary lives in the prefix region (developer/
            // system, before the first user msg). Pull it out and re-fold it into
            // the new summary instead of letting summaries stack.
            const priorIdx = prefix.findIndex((m) => typeof m.content === "string" && m.content.startsWith("[Summary so far"));
            let prior: ChatMessage[] = [];
            if (priorIdx >= 0) { prior = prefix.slice(priorIdx); prefix = prefix.slice(0, priorIdx); }
            const tail = conv.slice(conv.length - keepTurns);
            const middle = [...prior, ...conv.slice(0, conv.length - keepTurns)];
            const summary = await this.summarizeMessages(middle);
            if (!summary) {
                if (reason === "manual") { note("compaction failed (summary unavailable) — keeping full context"); }
                return;   // fail-safe
            }
            const role = this.cfg.supportsDeveloperRole !== false ? "developer" : "system";
            const synthetic: ChatMessage = {
                role,
                content: `[Summary so far — the earlier conversation was compacted to save context. The full transcript is preserved; call read_session to recover any detail (e.g. a tool's full output).]\n\n${summary}`,
            };
            const folded = middle.length;
            this.messages.length = 0;
            this.messages.push(...prefix, synthetic, ...tail);
            // Ledger marker (raw middle already committed by prior turns) + commit.
            ledger.appendMessage(this.sessionId, {
                role: "system", kind: "compaction", content: summary, turn: this.turnNo,
                summarizedCount: folded, keptTail: keepTurns, summary,
            });
            void ledger.commitTurn(this.sessionId, `compact — folded ${folded} msgs (${reason}, model=${this.model()})`);
            this.safePersist();
            note(`compacted ${folded} messages — context shrunk; full history preserved (read_session to recover)`);
        } finally {
            this.compacting = false;
            // A manual /compact is its own "turn" from the controller's view — close
            // it so the composer returns to idle. Auto runs after turn-end already.
            if (reason === "manual") { this.emit("event", { kind: "turn-end" }); }
        }
    }

    /** One-shot, non-streaming summarization call (no tools, no UI streaming). */
    private async summarizeMessages(messages: ChatMessage[]): Promise<string> {
        try {
            const loginToken = await this.authToken();
            const responses = this.cfg.api === "responses";
            const url = this.cfg.baseUrl.replace(/\/+$/, "") + (responses ? "/responses" : "/chat/completions");
            const instruction =
                "You are compacting a long agent conversation so it fits a smaller context window. " +
                "Summarize the transcript below, PRESERVING: decisions made, concrete facts, file paths touched, open tasks/todos, user constraints, and the current state. Drop chatter and resolved detours. " +
                "For tool calls keep only a one-line POINTER (e.g. 'ran shell: git status', 'edited Foo.cs') WITHOUT the tool output — the full output is recoverable via read_session. " +
                "Write a dense markdown summary (≤ ~1500 tokens) that lets the agent resume from this note alone.";
            const sys = this.cfg.supportsDeveloperRole !== false ? "developer" : "system";
            const reqMessages: ChatMessage[] = [
                { role: sys as ChatMessage["role"], content: instruction },
                { role: "user", content: this.renderForSummary(messages) },
            ];
            const body = responses
                ? { model: this.model(), input: toResponsesInput(reqMessages), stream: false }
                : { model: this.model(), messages: reqMessages, stream: false };
            const res = await fetch(url, { method: "POST", headers: this.headers(loginToken), body: JSON.stringify(body) });
            if (!res.ok) { return ""; }
            const json: any = await res.json();
            if (responses) {
                if (typeof json.output_text === "string" && json.output_text.trim()) { return json.output_text.trim(); }
                const parts: string[] = [];
                for (const item of json.output ?? []) {
                    for (const c of item.content ?? []) { if (typeof c.text === "string") { parts.push(c.text); } }
                }
                return parts.join("").trim();
            }
            return String(json?.choices?.[0]?.message?.content ?? "").trim();
        } catch {
            return "";
        }
    }

    /** Flattens messages to plain text for the summarizer (tool output trimmed). */
    private renderForSummary(messages: ChatMessage[]): string {
        const out: string[] = [];
        for (const m of messages) {
            const c = contentText(m.content);
            if (m.role === "tool") {
                out.push(`[tool result${m.name ? " " + m.name : ""}] ${c.slice(0, 400)}`);
            } else if (m.role === "assistant") {
                const calls = (m.tool_calls ?? []).map((t) => `${t.function.name}(${(t.function.arguments || "").slice(0, 80)})`).join(", ");
                out.push(`[assistant] ${c}${calls ? "\n  tools: " + calls : ""}`);
            } else {
                out.push(`[${m.role}] ${c}`);
            }
        }
        return out.join("\n");
    }

    private headers(loginToken?: string | null): Record<string, string> {
        const h: Record<string, string> = { "content-type": "application/json", ...this.cfg.headers };
        if (this.cfg.clientInfo) {
            h["x-client-id"] = this.cfg.clientInfo.id;
            h["x-client-version"] = this.cfg.clientInfo.version;
            h["x-client-hostname"] = this.cfg.clientInfo.hostname;
            h["x-client-os"] = this.cfg.clientInfo.os;
            h["user-agent"] = `${this.cfg.clientInfo.id}/${this.cfg.clientInfo.version} (${this.cfg.clientInfo.os}; ${this.cfg.clientInfo.hostname})`;
        }
        const hasAuth = Object.keys(h).some((k) => k.toLowerCase() === "authorization");
        if (!hasAuth && this.cfg.apiKey) {
            h["authorization"] = `Bearer ${this.cfg.apiKey}`;
        } else if (!hasAuth && loginToken) {
            // Fall back to the logged-in Sufficit token (native backend).
            h["authorization"] = `Bearer ${loginToken}`;
        }
        return h;
    }

    /** Resolves the login token only when needed (no explicit auth configured). */
    private async authToken(): Promise<string | null> {
        const provider = getOpenAITokenProvider();
        const hasAuth = Object.keys(this.cfg.headers).some((k) => k.toLowerCase() === "authorization");
        if (hasAuth || this.cfg.apiKey || !provider) { return null; }
        try { return await provider(); } catch { return null; }
    }

    /**
     * Best-effort model discovery from <baseUrl>/models, populating the shared
     * cache so `model()` can resolve a default. Used by run() when no model is
     * selected, so the very first turn after a reload still finds a model.
     * Skipped when models are pinned in settings (the configured list wins).
     */
    private async discoverModels(loginToken?: string | null): Promise<void> {
        if (this.cfg.models.length || !this.cfg.baseUrl) { return; }
        const url = this.cfg.baseUrl.replace(/\/+$/, "") + "/models";
        const headers: Record<string, string> = { ...this.cfg.headers };
        if (this.cfg.clientInfo) {
            headers["x-client-id"] = this.cfg.clientInfo.id;
            headers["x-client-version"] = this.cfg.clientInfo.version;
            headers["x-client-hostname"] = this.cfg.clientInfo.hostname;
            headers["x-client-os"] = this.cfg.clientInfo.os;
            headers["user-agent"] = `${this.cfg.clientInfo.id}/${this.cfg.clientInfo.version} (${this.cfg.clientInfo.os}; ${this.cfg.clientInfo.hostname})`;
        }
        const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
        if (!hasAuth && this.cfg.apiKey) {
            headers["authorization"] = `Bearer ${this.cfg.apiKey}`;
        } else if (!hasAuth && loginToken) {
            headers["authorization"] = `Bearer ${loginToken}`;
        }
        const res = await fetch(url, { headers });
        if (!res.ok) { return; }
        const json: any = await res.json();
        const raw: any[] = json?.data ?? json?.models ?? [];
        const list: string[] = [];
        const labels: Record<string, string> = {};
        const context: Record<string, number> = {};
        for (const m of raw) {
            const id = typeof m === "string" ? m : m?.id ?? m?.name;
            if (typeof id !== "string") { continue; }
            list.push(id);
            const name = typeof m === "object" ? (m?.name ?? m?.title) : undefined;
            if (typeof name === "string" && name && name !== id) { labels[id] = name; }
            const ctx = modelContextLength(m);
            if (ctx) { context[id] = ctx; }
        }
        if (list.length) {
            setDiscovered(this.cfg.baseUrl, list, labels, context);
            this.cfg.log?.(`[${this.backend}] discovered ${list.length} models from ${url}`);
        }
    }

    /** Append one entry to the lossless ledger for the current turn (best-effort). */
    private led(role: string, content: unknown, extra?: Record<string, unknown>): void {
        ledger.appendMessage(this.sessionId, { role, content, turn: this.turnNo, ...extra });
    }

    send(text: string, images?: string[], preamble?: string[]): void {
        // Intercept /compact: a local command (summarize the conversation to shrink
        // the model context), NOT a user turn to ship to the gateway.
        if (text.trim().toLowerCase() === "/compact") {
            void this.compact("manual");
            return;
        }
        // One-shot app instructions (todo capability, autonomy, policy) go in as
        // `developer` messages — above the user turn, below the preset's system —
        // instead of being glued onto the user text. Downgraded to `system` for
        // gateways that don't accept the developer role.
        const role = this.cfg.supportsDeveloperRole !== false ? "developer" : "system";
        // If the previous turn was interrupted (steer/cancel) it left a dangling
        // user message with no assistant reply. Sending another user message would
        // break role alternation (Anthropic-backed providers 400 on user→user).
        // Close the gap with a short assistant turn so the new user is valid.
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === "user") {
            this.messages.push({ role: "assistant", content: "(previous turn interrupted)" });
            ledger.appendMessage(this.sessionId, { role: "assistant", content: "(previous turn interrupted)", turn: this.turnNo });
        }
        for (const p of preamble ?? []) {
            if (p && p.trim()) {
                this.messages.push({ role, content: p });
                ledger.appendMessage(this.sessionId, { role, content: p, turn: this.turnNo + 1 });
            }
        }
        // Vision: inline attached images as image_url content parts so a
        // vision-capable model sees them directly (instead of getting a file
        // path it would read as binary). Unreadable files are skipped.
        const imageParts: ContentPart[] = [];
        for (const p of images ?? []) {
            try {
                const mime = mimeTypeFor(p) || "image/png";
                const b64 = fs.readFileSync(p).toString("base64");
                imageParts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
            } catch { /* skip files we can't read */ }
        }
        const userContent: string | ContentPart[] = imageParts.length
            ? [{ type: "text", text }, ...imageParts]
            : text;
        this.messages.push({ role: "user", content: userContent });
        // Refresh the continuous-follow-up north star. A substantive user turn is
        // a NEW task → adopt it as the objective and reset the progress digest. A
        // short continuation ("continue", "ok", "segue") keeps the prior objective
        // and its progress so the anchor stays meaningful across nudges.
        const taskText = text.trim();
        if (taskText.length >= 8 && !/^(continue|continuar|segue|prossiga|go on|keep going|ok|sim|yes|y)\b/i.test(taskText)) {
            this.objective = taskText.slice(0, 600);
            this.progress = [];
        }
        // Ledger/persistence stays text-based (no base64 bloat in the recall log).
        ledger.appendMessage(this.sessionId, {
            role: "user",
            content: imageParts.length ? `${text}\n[${imageParts.length} image(s) attached]` : text,
            turn: this.turnNo + 1,
        });
        if (!this.title) { this.title = text.trim().slice(0, 60); }
        this.safePersist();
        void this.run();
    }


    private shellExecutionMode(): ShellExecutionMode {
        // Per-conversation choice from the composer wins over static config,
        // so the user can flip silent/inline/terminal without changing settings.
        const v = String(this.options.execDisplay ?? (this.cfg as any).shellExecution ?? "silent");
        return v === "inline" || v === "terminal" ? v : "silent";
    }

    /** Resolves a tool's path argument to an absolute path against the session cwd. */
    private resolveToolPath(p: unknown): string | undefined {
        if (typeof p !== "string" || !p) { return undefined; }
        return path.isAbsolute(p) ? p : path.resolve(this.options.cwd, p);
    }

    cancel(): void {
        this.abort?.abort();
    }

    dispose(): void {
        this.abort?.abort();
    }

    aiTools(): { available: string[]; enabled: string[] } {
        const available = [...ALL_AI_TOOL_NAMES];
        // options.aiTools: undefined = all available; [] = none; else the subset.
        const enabled = this.options.aiTools === undefined ? [...available] : [...this.options.aiTools];
        return { available, enabled };
    }

    setAiTools(names: string[]): void {
        // Keep only known tool names; takes effect on the next turn (run() reads
        // this.options.aiTools live).
        const known = new Set(ALL_AI_TOOL_NAMES);
        this.options.aiTools = names.filter((n) => known.has(n));
    }

    private async run(): Promise<void> {
        this.abort = new AbortController();
        this.turnNo++;   // each run() is one conversation turn (ledger turn index)
        const responses = this.cfg.api === "responses";
        const base = this.cfg.baseUrl.replace(/\/+$/, "");
        const url = base + (responses ? "/responses" : "/chat/completions");
        const effort = this.options.reasoning;
        const loginToken = await this.authToken();   // logged-in Bearer, if needed
        // Auth guard: when the gateway has no explicit apiKey/Authorization
        // configured, it relies on the logged-in Sufficit token. If that token
        // is missing (not logged in, or the token didn't persist — e.g. a
        // code-server without a system keyring), fail early with a clear
        // message instead of sending an unauthenticated request that the
        // gateway answers with a cryptic HTTP 401.
        const noExplicitAuth = !this.cfg.apiKey
            && !Object.keys(this.cfg.headers).some((k) => k.toLowerCase() === "authorization");
        if (noExplicitAuth && !loginToken) {
            this.emit("event", { kind: "error", message: "Not authenticated: sign in to Sufficit (Accounts menu / avatar) to use the Sufficit AI backend. If you already signed in and the error persists, the token is not being stored in this environment (code-server without a keyring): set symposium.openai.apiKey or an Authorization header." });
            this.emit("event", { kind: "turn-end" });
            return;
        }
        // Model guard: never POST with an empty model (the gateway 400s). Try a
        // best-effort discovery from <baseUrl>/models first; if still empty,
        // tell the user to pick/configure a model instead of failing obscurely.
        if (!this.model()) {
            await this.discoverModels(loginToken).catch(() => undefined);
        }
        if (!this.model()) {
            this.emit("event", { kind: "error", message: "No model selected for Sufficit AI. Pick a model in the session selector or set symposium.openai.model / symposium.openai.models." });
            this.emit("event", { kind: "turn-end" });
            return;
        }
        // Tools exposed to the model: local shell/filesystem tools (always — the
        // parity with the CLI backends) plus memory/web tools when the hub is
        // configured. The model calls them; we execute and feed results back.
        const memoryTools = this.hub.configured()
            ? (responses ? AI_TOOLS_RESPONSES : AI_TOOLS)
            : [];
        const localTools = responses ? LOCAL_TOOLS_RESPONSES : LOCAL_TOOLS;
        // VS Code Language Model Tools (runInTerminal, runTask, runTests, …):
        // computed fresh each turn so registry/setting changes take effect.
        const vscodeTools = responses ? lmToolDefsResponses() : lmToolDefs();

        // How many tool round-trips one turn may run before pausing. In
        // autonomous mode (presence "away") there is NO limit; otherwise the
        // configurable cap applies (default 50) so it pauses for "continue".
        const unlimited = this.options.autonomy === "away";
        // Even in unlimited (autonomy) mode keep an absolute hard ceiling so a
        // runaway tool loop can never wedge the turn forever (busy stuck).
        const HARD_CAP = 200;
        const softCap = unlimited ? HARD_CAP : Math.max(1, this.cfg.maxToolHops ?? 50);
        const maxHops = Math.min(softCap, HARD_CAP);
        let hitCap = !unlimited;   // cleared when the model finishes on its own
        // Loop guard: if the model repeats the exact same tool+args many times
        // in a row without progress, break out instead of spinning forever.
        const recentCalls: string[] = [];
        const REPEAT_LIMIT = 6;
        // Optional anti-loop: stop the turn after N consecutive tool-only rounds
        // (no assistant reply). Off by default (0); user-set in Preferences.
        const noProgressStop = Math.max(0, this.cfg.noProgressStop ?? 0);
        let noTextHops = 0;
        try {
            // Tool-call loop: keep round-tripping while the model requests tools.
            for (let hop = 0; hop < maxHops; hop++) {
                this.abort = new AbortController();
                const windowed = this.windowedMessages();
                // Continuous follow-up: once history is being windowed out (or after
                // a few hops into the tool-loop), append a fresh objective+progress
                // anchor at the tail so a small-context model keeps the thread.
                const anchor = (this.windowTruncated() || hop >= 3) ? this.followupAnchor() : undefined;
                const outMessages = anchor ? [...windowed, anchor] : windowed;
                const body: Record<string, unknown> = responses
                    ? { model: this.model(), input: toResponsesInput(outMessages), stream: true }
                    : { model: this.model(), messages: outMessages, stream: true, stream_options: { include_usage: true } };
                // Gate by the bound agent-def's allowlist (options.aiTools); when
                // unset, expose all; when set to [], expose none (tools off).
                const allow = this.options.aiTools;
                const toolList = filterTools<{ function?: { name: string }; name?: string }>(
                    [...memoryTools, ...localTools, ...vscodeTools] as { function?: { name: string }; name?: string }[], allow);
                if (toolList.length > 0) {
                    body.tools = toolList;
                    body.tool_choice = "auto";
                }
                if (effort && effort !== "default") {
                    if (responses) { body.reasoning = { effort }; }
                    else { body.reasoning_effort = effort; }
                }
                this.cfg.log?.(`[${this.backend}] POST ${url} api=${this.cfg.api} model=${this.model()} tools=${toolList.length} hop=${hop}`);
                // Ledger audit: record the LITERAL request body (truth of what the
                // LLM received this hop) — feeds the "Request" inspection view.
                ledger.recordRequest(this.sessionId, body);
                const res = await fetch(url, {
                    method: "POST", headers: this.headers(loginToken), body: JSON.stringify(body), signal: this.abort.signal,
                });
                if (!res.ok || !res.body) {
                    const detail = await res.text().catch(() => "");
                    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
                    this.emit("event", { kind: "error", message: `HTTP ${res.status} ${res.statusText} ${detail}`.trim(), retryable });
                    hitCap = false;
                    break;
                }
                const { text, toolCalls, aborted, usage } = await this.consume(res.body, this.model());

                // Context monitor: report token usage for this request. inputTokens
                // is the prompt size = the live context the model just saw, so the
                // meter tracks "context used / window" like the CLI backends.
                if (usage && (usage.inputTokens || usage.outputTokens)) {
                    this.lastInputTokens = usage.inputTokens || this.lastInputTokens;
                    this.emit("event", {
                        kind: "usage",
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        cacheRead: usage.cacheRead,
                        contextWindow: this.contextWindow(),
                    });
                }

                // Stream paused/interrupted mid-turn: keep the partial assistant
                // reply (and any partial tool calls) in history so context is not
                // lost on the next message, then stop this turn.
                if (aborted) {
                    if (toolCalls.length > 0) {
                        this.messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
                        if (text) { this.led("assistant", text); }
                        // Satisfy the API contract: every tool_call needs a tool reply.
                        for (const tc of toolCalls) {
                            this.messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: "(interrupted before execution)" });
                        }
                    } else if (text) {
                        this.messages.push({ role: "assistant", content: text, model: this.model() });
                        this.led("assistant", text);
                    }
                    hitCap = false;
                    break;
                }

                if (toolCalls.length === 0) {
                    // Always record an assistant turn, even when the model returned
                    // empty text (reasoning-only / empty content). Skipping it leaves
                    // a dangling user/developer turn; Anthropic-backed gateways then
                    // 400 on the next message because roles no longer alternate.
                    this.messages.push({ role: "assistant", content: text || "", model: this.model() });
                    if (text) { this.led("assistant", text); }
                    hitCap = false;
                    break;
                }

                // Optional no-progress stop (Preferences). Count consecutive
                // tool-only rounds; nudge near the limit, stop at it.
                if (noProgressStop > 0) {
                    if (text.trim()) { noTextHops = 0; } else { noTextHops++; }
                    if (noTextHops === Math.ceil(noProgressStop / 2)) {
                        const nudgeRole = this.cfg.supportsDeveloperRole !== false ? "developer" : "system";
                        this.messages.push({ role: nudgeRole, content: "[Convergence] You have run several tools in a row without replying. If you already have enough information, STOP calling tools and answer now; otherwise take only the single next necessary step." });
                    }
                    if (noTextHops >= noProgressStop) {
                        this.emit("event", { kind: "text", text: `\n\n_(stopped after ${noTextHops} tool steps with no reply — send "continue" to resume)_` });
                        hitCap = false;
                        break;
                    }
                }

                // Record the assistant turn that requested tools, then run each.
                this.messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
                if (text) { this.led("assistant", text); }
                // Persist mid-turn: a window reload restarts the extension host
                // and wipes the in-memory render log, so only what's on disk
                // survives. Without this, reloading while tools run loses the
                // whole in-progress turn back to the last user message.
                this.safePersist();
                // Loop guard: detect the model spinning on the same call(s).
                const sig = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).join("|");
                recentCalls.push(sig);
                if (recentCalls.length > REPEAT_LIMIT) { recentCalls.shift(); }
                if (recentCalls.length === REPEAT_LIMIT && recentCalls.every((c) => c === sig)) {
                    this.emit("event", { kind: "text", text: `\n\n_(stopped: the model repeated the same tool call ${REPEAT_LIMIT}x without progress)_` });
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
                    const counts = diffCounts(tc.function.name, args);
                    const editPath = counts ? this.resolveToolPath(args.path) : undefined;
                    if (counts && editPath && this.sessionId) {
                        snapshots.capture(this.sessionId, editPath);
                    }
                    this.emit("event", {
                        kind: "tool-start",
                        toolName: tc.function.name,
                        detail: friendlyToolDetail(tc.function.name, args),
                        path: editPath ?? toolPath(tc.function.name, args),
                        added: counts?.added,
                        removed: counts?.removed,
                        diff: editDiff(tc.function.name, args),
                        toolId: tc.id,
                        input: tc.function.arguments,
                    });
                    const shellMode = this.shellExecutionMode();
                    const progress = {
                        onData: (chunk: string) => this.emit("event", { kind: "tool-output", toolName: tc.function.name, toolId: tc.id, text: chunk }),
                        onTerminal: (terminalName: string) => this.emit("event", { kind: "tool-start", toolName: tc.function.name, detail: `watching in terminal: ${terminalName}`, toolId: tc.id, terminalName }),
                        onNotify: (message: string) => this.emit("event", { kind: "tool-output", toolName: tc.function.name, toolId: tc.id, text: `\n[notify] ${message}\n` }),
                    };
                    const result = isLmTool(tc.function.name)
                        ? await invokeLmTool(tc.function.name, args)
                        : await runAiTool(tc.function.name, args, { hub: this.hub, cwd: this.options.cwd, permission: this.options.permission, sessionId: this.sessionId, shellExecution: shellMode, progress });
                    this.emit("event", { kind: "tool-end", toolName: tc.function.name, toolId: tc.id, result });
                    this.messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
                    // Ledger (lossless): record the tool call + its result so the full
                    // transcript and read_session survive context compaction.
                    this.led("tool", result, { name: tc.function.name, detail: friendlyToolDetail(tc.function.name, args) });
                    // Feed the continuous-follow-up digest (one compact line per step).
                    const step = friendlyToolDetail(tc.function.name, args);
                    this.progress.push((tc.function.name + (step ? " — " + step : "")).slice(0, 110));
                    if (this.progress.length > 60) { this.progress.shift(); }
                    this.safePersist();   // each completed tool round is durable immediately
                }
                // loop again so the model can use the tool results
            }
            if (hitCap) {
                this.emit("event", { kind: "text", text: `\n\n_(paused after ${maxHops} tool steps — send "continue" to proceed)_` });
            }
        } catch (error) {
            if ((error as any)?.name !== "AbortError") {
                const msg = error instanceof Error ? error.message : String(error);
                // Network/transport failures (DNS, connection reset, timeout,
                // "fetch failed", "terminated") are transient and safe to retry
                // with the exact same request — unlike a 4xx or a logic error.
                const retryable = /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|terminated|aborted|timeout/i.test(msg);
                this.emit("event", { kind: "error", message: msg, retryable });
            }
        }
        this.safePersist();
        // One immutable ledger commit per turn — the lossless snapshot the Chat
        // mirror and read_session read from, and the safety net under /compact.
        void ledger.commitTurn(this.sessionId, `turn ${this.turnNo} — user→assistant (model=${this.model()})`);
        // Auto-compaction: if the context crossed the threshold this turn, fold it
        // before the next send (lazy, so it never delays this turn-end).
        this.maybeAutoCompact();
        this.emit("event", { kind: "turn-end" });
    }

    /**
     * Reads an SSE stream, emitting text deltas. Also accumulates streamed
     * tool_calls (chat completions) so the caller can run them and continue.
     */
    private async consume(stream: ReadableStream<Uint8Array>, m: string): Promise<{ text: string; toolCalls: ToolCall[]; aborted: boolean; usage?: ApiUsage }> {
        const responses = this.cfg.api === "responses";
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let assistant = "";
        let usage: ApiUsage | undefined;  // final token counts, when the API reports them
        const calls: ToolCall[] = []; // indexed by streamed tool_call index
        let lastFnIndex = 0;          // responses API: index of the most recent function_call
        const done = () => ({ text: assistant, toolCalls: calls.filter((c) => c && c.function.name), aborted: false, usage });
        try {
        for (; ;) {
            const r = await reader.read();
            if (r.done) { break; }
            buf += decoder.decode(r.value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith("data:")) { continue; }
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") { return done(); }
                try {
                    const json = JSON.parse(payload);
                    if (responses) {
                        const ty = json?.type;
                        if (ty === "response.output_text.delta" && typeof json.delta === "string") {
                            assistant += json.delta; this.emit("event", { kind: "text", text: json.delta, model: m, modelLabel: this.label(m) });
                        } else if (ty === "response.output_item.added" && json?.item?.type === "function_call") {
                            // New function call: index by output_index; carry call_id + name.
                            const i = json.output_index ?? calls.length;
                            calls[i] = { id: json.item.call_id ?? json.item.id ?? "", type: "function", function: { name: json.item.name ?? "", arguments: json.item.arguments ?? "" } };
                            lastFnIndex = i;
                        } else if (ty === "response.function_call_arguments.delta" && typeof json.delta === "string") {
                            const i = json.output_index ?? lastFnIndex;
                            if (calls[i]) { calls[i].function.arguments += json.delta; }
                        } else if (ty === "response.function_call_arguments.done" && typeof json.arguments === "string") {
                            // Some gateways send the full arguments only in the .done event (no deltas).
                            const i = json.output_index ?? lastFnIndex;
                            if (calls[i]) { calls[i].function.arguments = json.arguments; }
                        } else if (ty === "response.error") {
                            this.emit("event", { kind: "error", message: String(json?.error?.message ?? "response error") });
                        } else if ((ty === "response.completed" || ty === "response.incomplete") && json?.response?.usage) {
                            const u = json.response.usage;
                            usage = {
                                inputTokens: Number(u.input_tokens ?? 0),
                                outputTokens: Number(u.output_tokens ?? 0),
                                cacheRead: Number(u.input_tokens_details?.cached_tokens ?? 0),
                            };
                        }
                        continue;
                    }
                    // Final usage chunk (stream_options.include_usage): choices is
                    // empty and `usage` carries the turn's token totals.
                    if (json?.usage) {
                        const u = json.usage;
                        usage = {
                            inputTokens: Number(u.prompt_tokens ?? 0),
                            outputTokens: Number(u.completion_tokens ?? 0),
                            cacheRead: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
                        };
                    }
                    const delta = json?.choices?.[0]?.delta;
                    if (typeof delta?.content === "string" && delta.content) {
                        assistant += delta.content; this.emit("event", { kind: "text", text: delta.content, model: m, modelLabel: this.label(m) });
                    }
                    // Accumulate tool_calls: name+id arrive first, arguments stream in chunks.
                    for (const tc of delta?.tool_calls ?? []) {
                        const i = tc.index ?? 0;
                        if (!calls[i]) { calls[i] = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } }; }
                        if (tc.id) { calls[i].id = tc.id; }
                        if (tc.function?.name) { calls[i].function.name = tc.function.name; }
                        if (tc.function?.arguments) { calls[i].function.arguments += tc.function.arguments; }
                    }
                } catch {
                    // partial/non-JSON keepalive line; ignore
                }
            }
        }
        } catch (err) {
            // A paused/interrupted stream (AbortError or transport drop) must NOT
            // discard what we already received — return the partial accumulation
            // so the caller can persist the partial assistant turn and keep context.
            try { reader.cancel(); } catch { /* ignore */ }
            return { text: assistant, toolCalls: calls.filter((c) => c && c.function.name), aborted: true };
        }
        return done();
    }
}
