import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
} from "./types";
import { TODO_INJECTION } from "./todos";
import { HubClient } from "../sync/hubClient";
import { AI_TOOLS, AI_TOOLS_RESPONSES, LOCAL_TOOLS, LOCAL_TOOLS_RESPONSES, ALL_AI_TOOL_NAMES, filterTools, runAiTool, ShellExecutionMode } from "./aiTools";
import { lmToolDefs, lmToolDefsResponses, isLmTool, invokeLmTool } from "./lmTools";
import { buildOpenAIModelList } from "./openaiModels";
import * as ledger from "../ledger";
import { getCached, setCached, isFresh } from "./modelCache";

/** OpenAI tool call as streamed/accumulated from chat completions deltas. */
interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

type ChatMsg = {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    /** Model id that produced this assistant message (kept across handoff). */
    model?: string;
};

interface StoredSession {
    id: string;
    backend: string;
    title: string;
    cwd: string;
    model: string;
    updatedAt: string;
    messages: ChatMsg[];
}

/** Per-backend store dir for API-adapter transcripts (no CLI to persist them). */
function storeDir(backend: string): string {
    return path.join(os.homedir(), ".symposium", "sessions", backend);
}
function storePath(backend: string, id: string): string {
    return path.join(storeDir(backend), id + ".json");
}
function readStored(backend: string, id: string): StoredSession | undefined {
    try { return JSON.parse(fs.readFileSync(storePath(backend, id), "utf8")); } catch { return undefined; }
}
function writeStored(s: StoredSession): void {
    try {
        fs.mkdirSync(storeDir(s.backend), { recursive: true });
        fs.writeFileSync(storePath(s.backend, s.id), JSON.stringify(s));
    } catch { /* best-effort persistence */ }
}

export interface OpenAIAdapterConfig {
    /** Detailed caller identity for gateway/activity diagnostics. */
    clientInfo?: { id: string; version: string; hostname: string; os: string };
    /** Which API to call: chat completions or the Responses API. */
    api: "chat" | "responses";
    /** Base URL of an OpenAI-compatible API, e.g. https://api.sufficit-ai/v1 */
    baseUrl: string;
    /** Default model (empty = first of models). */
    model: string;
    /** Models offered in the picker (empty = auto-discover from /models). */
    models: string[];
    /** Custom headers (e.g. Authorization, x-api-key) for the sufficit-ai gateway. */
    headers: Record<string, string>;
    /** Convenience: if set and no Authorization header, sent as Bearer. */
    apiKey?: string;
    /**
     * Whether this gateway supports the OpenAI `developer` message role.
     * Built-in Sufficit AI handles this upstream; custom gateways may need the
     * prompt downgraded to `system`.
     */
    supportsDeveloperRole?: boolean;
    /** Max tool round-trips per turn before pausing (default 50). */
    maxToolHops?: number;
    /**
     * Sliding window: max conversation messages sent per request.
     * System/developer prefix and the first user turn are always preserved.
     * Default 40 (~20 turns). 0 = no trimming (old behaviour).
     */
    maxHistoryMessages?: number;
    /** How local shell tool execution is surfaced: silent, inline stream, or visible VS Code terminal. */
    shellExecution?: ShellExecutionMode;
    log?: (message: string) => void;
}

// Discovered model ids and id→friendly-name per base URL (GET /models cache).
const discoveredModels = new Map<string, string[]>();
const discoveredLabels = new Map<string, Record<string, string>>();

/**
 * Optional Sufficit login access-token provider. When set (at activation) and an
 * adapter has no explicit apiKey/Authorization, the logged-in token is used as
 * the Bearer — so the native "Sufficit AI" backend works right after login with
 * no manual config.
 */
let openaiTokenProvider: (() => Promise<string | null>) | undefined;
export function setOpenAITokenProvider(fn: () => Promise<string | null>): void {
    openaiTokenProvider = fn;
}

type ChatMessage = ChatMsg;

/**
 * A direct OpenAI-compatible chat session (no CLI): streams /chat/completions
 * over HTTP with a custom base URL + headers, to talk straight to sufficit-ai
 * models. Stateless server-side, so history is kept here and persisted to disk
 * so the session survives a reload (the API has no transcript of its own).
 */
class OpenAISession extends EventEmitter implements AgentSession {
    readonly sessionId: string;
    private readonly messages: ChatMessage[] = [];
    private abort: AbortController | undefined;
    private title = "";
    private readonly hub = new HubClient();
    private turnNo = 0;

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

    private ledgerMeta(): import("../ledger").LedgerMeta {
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
            || discoveredModels.get(this.cfg.baseUrl)?.[0] || "";
    }

    /** Friendly name for a model id, from discovery (falls back to the id). */
    private label(id: string): string {
        if (!id) { return ""; }
        return discoveredLabels.get(this.cfg.baseUrl)?.[id] ?? id;
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

        // Split into protected prefix (system/developer up to first user msg)
        // and the conversation body (first user turn onwards).
        let firstUserIdx = this.messages.findIndex((m) => m.role === "user");
        if (firstUserIdx === -1) { return this.messages; }
        // Include the first user message itself in the protected prefix.
        firstUserIdx += 1;

        const prefix = this.messages.slice(0, firstUserIdx);
        const conv = this.messages.slice(firstUserIdx);

        if (conv.length <= max) { return this.messages; }
        return [...prefix, ...conv.slice(conv.length - max)];
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
        const hasAuth = Object.keys(this.cfg.headers).some((k) => k.toLowerCase() === "authorization");
        if (hasAuth || this.cfg.apiKey || !openaiTokenProvider) { return null; }
        try { return await openaiTokenProvider(); } catch { return null; }
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
        for (const m of raw) {
            const id = typeof m === "string" ? m : m?.id ?? m?.name;
            if (typeof id !== "string") { continue; }
            list.push(id);
            const name = typeof m === "object" ? (m?.name ?? m?.title) : undefined;
            if (typeof name === "string" && name && name !== id) { labels[id] = name; }
        }
        if (list.length) {
            discoveredModels.set(this.cfg.baseUrl, list);
            discoveredLabels.set(this.cfg.baseUrl, labels);
            this.cfg.log?.(`[${this.backend}] discovered ${list.length} models from ${url}`);
        }
    }

    send(text: string, _images?: string[], preamble?: string[]): void {
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
            this.messages.push({ role: "assistant", content: "(turno anterior interrompido)" });
            ledger.appendMessage(this.sessionId, { role: "assistant", content: "(turno anterior interrompido)", turn: this.turnNo });
        }
        for (const p of preamble ?? []) {
            if (p && p.trim()) {
                this.messages.push({ role, content: p });
                ledger.appendMessage(this.sessionId, { role, content: p, turn: this.turnNo + 1 });
            }
        }
        this.messages.push({ role: "user", content: text });
        ledger.appendMessage(this.sessionId, { role: "user", content: text, turn: this.turnNo + 1 });
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
        try {
            // Tool-call loop: keep round-tripping while the model requests tools.
            for (let hop = 0; hop < maxHops; hop++) {
                this.abort = new AbortController();
                const windowed = this.windowedMessages();
                const body: Record<string, unknown> = responses
                    ? { model: this.model(), input: toResponsesInput(windowed), stream: true }
                    : { model: this.model(), messages: windowed, stream: true };
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
                const { text, toolCalls, aborted } = await this.consume(res.body, this.model());

                // Stream paused/interrupted mid-turn: keep the partial assistant
                // reply (and any partial tool calls) in history so context is not
                // lost on the next message, then stop this turn.
                if (aborted) {
                    if (toolCalls.length > 0) {
                        this.messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
                        // Satisfy the API contract: every tool_call needs a tool reply.
                        for (const tc of toolCalls) {
                            this.messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: "(interrupted before execution)" });
                        }
                    } else if (text) {
                        this.messages.push({ role: "assistant", content: text, model: this.model() });
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
                    hitCap = false;
                    break;
                }

                // Record the assistant turn that requested tools, then run each.
                this.messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
                // Loop guard: detect the model spinning on the same call(s).
                const sig = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).join("|");
                recentCalls.push(sig);
                if (recentCalls.length > REPEAT_LIMIT) { recentCalls.shift(); }
                if (recentCalls.length === REPEAT_LIMIT && recentCalls.every((c) => c === sig)) {
                    this.emit("event", { kind: "text", text: `\n\n_(interrompi: o modelo repetiu a mesma chamada de ferramenta ${REPEAT_LIMIT}x sem progresso)_` });
                    hitCap = false;
                    break;
                }
                for (const tc of toolCalls) {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* leave empty */ }
                    this.emit("event", {
                        kind: "tool-start",
                        toolName: tc.function.name,
                        detail: friendlyToolDetail(tc.function.name, args),
                        path: toolPath(tc.function.name, args),
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
        this.emit("event", { kind: "turn-end" });
    }

    /**
     * Reads an SSE stream, emitting text deltas. Also accumulates streamed
     * tool_calls (chat completions) so the caller can run them and continue.
     */
    private async consume(stream: ReadableStream<Uint8Array>, m: string): Promise<{ text: string; toolCalls: ToolCall[]; aborted: boolean }> {
        const responses = this.cfg.api === "responses";
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let assistant = "";
        const calls: ToolCall[] = []; // indexed by streamed tool_call index
        let lastFnIndex = 0;          // responses API: index of the most recent function_call
        const done = () => ({ text: assistant, toolCalls: calls.filter((c) => c && c.function.name), aborted: false });
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
                        }
                        continue;
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

/** A human-readable one-liner for a tool call, instead of raw JSON args. */
function friendlyToolDetail(name: string, args: Record<string, unknown>): string {
    const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
    // A description provided by the model is the human intent — show it.
    if (typeof args.description === "string" && args.description.trim()) {
        const d0 = args.description.trim();
        return d0.length > 160 ? d0.slice(0, 159) + "…" : d0;
    }
    let d = "";
    switch (name) {
        case "shell": d = s(args.command).split("\n")[0]; break;
        case "fetch_url": case "open_url": d = s(args.url); break;
        case "read_file": case "write_file": case "list_dir": d = s(args.path); break;
        case "memory_search": case "web_search": d = s(args.query); break;
        case "memory_save": d = s(args.title); break;
        default: {
            const first = Object.values(args).find((v) => typeof v === "string");
            d = first ? s(first) : (Object.keys(args).length ? JSON.stringify(args) : "");
        }
    }
    return d.length > 160 ? d.slice(0, 159) + "…" : d;
}

/** File path a tool acts on (gives the row a file icon); else undefined. */
function toolPath(name: string, args: Record<string, unknown>): string | undefined {
    if ((name === "read_file" || name === "write_file" || name === "list_dir") && typeof args.path === "string") {
        return args.path;
    }
    return undefined;
}

/**
 * Converts the internal chat-shaped message log into Responses API `input`
 * items: plain messages stay {role,content}; an assistant tool turn becomes one
 * `function_call` item per call; a tool result becomes a `function_call_output`.
 */
function toResponsesInput(messages: ChatMessage[]): unknown[] {
    const out: unknown[] = [];
    for (const m of messages) {
        if (m.role === "tool") {
            out.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content ?? "" });
            continue;
        }
        if (m.role === "assistant" && m.tool_calls?.length) {
            if (m.content) { out.push({ role: "assistant", content: m.content }); }
            for (const tc of m.tool_calls) {
                out.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
            }
            continue;
        }
        out.push({ role: m.role, content: m.content ?? "" });
    }
    return out;
}

export class OpenAIAdapter implements AgentAdapter {
    /**
     * @param backend  unique id for this adapter instance (built-in "openai" or
     *                 a custom adapter id).
     * @param name     display name shown in the UI.
     */
    constructor(
        readonly backend: string,
        readonly displayName: string,
        private readonly getConfig: () => OpenAIAdapterConfig,
    ) { }

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        const cfg = this.getConfig();
        if (!cfg.baseUrl) { return { ok: false, error: `set baseUrl for ${this.displayName}` }; }
        // Best-effort model discovery so the picker is populated when opened.
        await this.discoverModels(cfg).catch(() => undefined);
        return { ok: true, version: cfg.baseUrl };
    }

    async listSessions(): Promise<SessionInfo[]> {
        const dir = storeDir(this.backend);
        let files: string[];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
        const out: SessionInfo[] = [];
        for (const f of files) {
            const s = readStored(this.backend, f.slice(0, -5));
            if (s) {
                out.push({ backend: this.backend, sessionId: s.id, title: s.title || "Session", cwd: s.cwd, updatedAt: new Date(s.updatedAt), model: s.model });
            }
        }
        return out;
    }

    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        const s = readStored(this.backend, info.sessionId);
        if (!s) { return []; }
        return s.messages
            .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0)
            .map((m) => ({
                role: m.role as "user" | "assistant",
                text: m.content as string,
                model: m.role === "assistant" ? m.model : undefined,
                modelLabel: m.role === "assistant" && m.model ? (discoveredLabels.get(this.getConfig().baseUrl)?.[m.model] ?? m.model) : undefined,
            }));
    }

    async deleteSession(info: SessionInfo): Promise<void> {
        try { fs.rmSync(storePath(this.backend, info.sessionId), { force: true }); } catch { /* ignore */ }
    }

    start(options: SessionStartOptions): AgentSession {
        return new OpenAISession(this.backend, this.getConfig(), options);
    }

    /** API backend: takes one-shot app instructions as developer messages. */
    roleAware(): boolean { return true; }

    /** GET <baseUrl>/models → cache the offered model ids (OpenAI shape). */
    private async discoverModels(cfg: OpenAIAdapterConfig): Promise<void> {
        const url = cfg.baseUrl.replace(/\/+$/, "") + "/models";
        const headers: Record<string, string> = { ...cfg.headers };
        if (cfg.clientInfo) {
            headers["x-client-id"] = cfg.clientInfo.id;
            headers["x-client-version"] = cfg.clientInfo.version;
            headers["x-client-hostname"] = cfg.clientInfo.hostname;
            headers["x-client-os"] = cfg.clientInfo.os;
            headers["user-agent"] = `${cfg.clientInfo.id}/${cfg.clientInfo.version} (${cfg.clientInfo.os}; ${cfg.clientInfo.hostname})`;
        }
        const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
        if (!hasAuth && cfg.apiKey) {
            headers["authorization"] = `Bearer ${cfg.apiKey}`;
        } else if (!hasAuth && openaiTokenProvider) {
            const t = await openaiTokenProvider().catch(() => null);
            if (t) { headers["authorization"] = `Bearer ${t}`; }
        }
        const res = await fetch(url, { headers });
        if (!res.ok) { return; }
        const json: any = await res.json();
        const raw: any[] = json?.data ?? json?.models ?? [];
        const list: string[] = [];
        const labels: Record<string, string> = {};
        for (const m of raw) {
            const id = typeof m === "string" ? m : m?.id ?? m?.name;
            if (typeof id !== "string") { continue; }
            list.push(id);
            const name = typeof m === "object" ? (m?.name ?? m?.title) : undefined;
            if (typeof name === "string" && name && name !== id) { labels[id] = name; }
        }
        if (list.length) {
            discoveredModels.set(cfg.baseUrl, list);
            discoveredLabels.set(cfg.baseUrl, labels);
            const cacheKey = `openai:${cfg.baseUrl}`;
            setCached(cacheKey, { models: list, labels, lastUpdate: new Date().toISOString() });
        }
        cfg.log?.(`[${this.backend}] discovered ${list.length} models from ${url}`);
    }

    /** Friendly id→name labels for the model picker (from discovery). */
    modelLabels(): Record<string, string> {
        return discoveredLabels.get(this.getConfig().baseUrl) ?? {};
    }

    models(): string[] {
        const cfg = this.getConfig();
        // Seed in-memory cache from file cache when the process-level map is empty.
        if (!discoveredModels.has(cfg.baseUrl)) {
            const cacheKey = `openai:${cfg.baseUrl}`;
            const stored = getCached(cacheKey);
            if (stored?.models.length) {
                discoveredModels.set(cfg.baseUrl, stored.models);
                discoveredLabels.set(cfg.baseUrl, stored.labels ?? {});
            }
        }
        const configured = cfg.models.length ? cfg.models : (discoveredModels.get(cfg.baseUrl) ?? []);
        return buildOpenAIModelList(configured, cfg.model);
    }

    /**
     * Force a (re)discovery from <baseUrl>/models, then return the freshly
     * built list + labels. The chat surface awaits this right after opening a
     * dialogue so the picker reflects the real server models even when the
     * discovery cache was empty (e.g. first session after a reload). When the
     * models are pinned in settings, discovery is skipped — the configured
     * list wins.
     */
    async refreshModels(force = false): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        if (!cfg.models.length && cfg.baseUrl) {
            // Skip network if file cache is fresh and not forced
            const cacheKey = `openai:${cfg.baseUrl}`;
            const stored = getCached(cacheKey);
            if (!force && stored && isFresh(stored)) {
                discoveredModels.set(cfg.baseUrl, stored.models);
                discoveredLabels.set(cfg.baseUrl, stored.labels ?? {});
            } else {
                await this.discoverModels(cfg).catch(() => undefined);
            }
        }
        return { models: this.models(), labels: this.modelLabels() };
    }

    // Common OpenAI reasoning_effort values; "default" omits the param.
    reasoningLevels(): string[] {
        return ["default", "minimal", "low", "medium", "high"];
    }

    // No native plan tool over the raw API: inject one and parse a ```todo block.
    hasNativeTodo(): boolean { return false; }
    todoInjection(): string { return TODO_INJECTION; }
}
