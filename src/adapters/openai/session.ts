import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AgentSession, SessionStartOptions } from "../types";
import { contextWindowFor, mimeTypeFor } from "../parse";
import { HubClient } from "../../sync/hubClient";
import { ALL_AI_TOOL_NAMES, ShellExecutionMode } from "../aiTools";
import * as ledger from "../../ledger";
import { ChatMessage, ContentPart, OpenAIAdapterConfig } from "./types";
import { readStored, writeStored } from "./store";
import { getDiscoveredContext, getDiscoveredLabels, getDiscoveredModels } from "./models";
import { buildHeaders, resolveAuthToken } from "./httpAuth";
import { discoverModels as discoverModelsFromCatalog } from "./discovery";
import { Compactor } from "./compactor";
import { TurnRunner } from "./turnRunner";
import { RequestEstimate } from "./requestWindow";

/**
 * A direct OpenAI-compatible chat session (no CLI): streams /chat/completions
 * over HTTP with a custom base URL + headers, to talk straight to sufficit-ai
 * models. Stateless server-side, so history is kept here and persisted to disk
 * so the session survives a reload (the API has no transcript of its own).
 */
export class OpenAISession extends EventEmitter implements AgentSession {
    readonly sessionId: string;
    private readonly messages: ChatMessage[] = [];
    private title = "";
    private readonly hub = new HubClient();
    private turnNo = 0;
    // Continuous follow-up anchor (small-context guardrail). `objective` is the
    // current task (north star), updated on each substantive user turn; `progress`
    // is a rolling digest of tool steps taken on it. Re-injected fresh into every
    // windowed request so the model can't lose the thread mid tool-loop.
    private objective = "";
    private progress: string[] = [];
    // Last reported prompt size — feeds the compactor's auto-compact threshold.
    private lastInputTokens = 0;
    // Context compaction + the per-turn streaming loop; both constructor-
    // initialized (they eagerly read cfg/options/sessionId).
    private readonly compactor: Compactor;
    private readonly runner: TurnRunner;

    constructor(
        readonly backend: string,
        private readonly cfg: OpenAIAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        // Resume a stored session if asked, else start a fresh one.
        const resumed = options.resumeSessionId ? readStored(backend, options.resumeSessionId) : undefined;
        // Orphan recovery: if a resume was requested but the store file is
        // missing, keep the requested id (don't generate a new one!) and try to
        // reconstruct messages from the ledger so the session reappears intact.
        if (!resumed && options.resumeSessionId && ledger.hasLedger(options.resumeSessionId)) {
            this.sessionId = options.resumeSessionId;
            for (const m of ledger.readMessages(this.sessionId)) {
                if (m.role === "user" || m.role === "assistant") {
                    const text = typeof m.content === "string" ? m.content : "";
                    if (text) { this.messages.push({ role: m.role, content: text }); }
                }
            }
            if (!this.title && this.messages.length) {
                const firstUser = this.messages.find((m) => m.role === "user");
                if (firstUser) { this.title = (typeof firstUser.content === "string" ? firstUser.content : "").trim().slice(0, 60); }
            }
        } else {
            this.sessionId = resumed?.id ?? randomUUID();
        }
        this.compactor = new Compactor({
            cfg: this.cfg,
            sessionId: this.sessionId,
            getMessages: () => this.messages,
            getTurnNo: () => this.turnNo,
            getLastInputTokens: () => this.lastInputTokens,
            model: () => this.model(),
            contextWindow: () => this.contextWindow(),
            authToken: () => this.authToken(),
            headers: (loginToken) => this.headers(loginToken),
            emit: (event) => { this.emit("event", event); },
            safePersist: () => this.safePersist(),
        });
        this.runner = new TurnRunner({
            cfg: this.cfg,
            options: this.options,
            sessionId: this.sessionId,
            backend: this.backend,
            hub: this.hub,
            getMessages: () => this.messages,
            getProgress: () => this.progress,
            bumpTurnNo: () => { this.turnNo++; },
            getTurnNo: () => this.turnNo,
            getLastInputTokens: () => this.lastInputTokens,
            setLastInputTokens: (n) => { this.lastInputTokens = n; },
            emit: (event) => { this.emit("event", event); },
            model: () => this.model(),
            label: (id) => this.label(id),
            contextWindow: () => this.contextWindow(),
            headers: (loginToken) => this.headers(loginToken),
            authToken: () => this.authToken(),
            discoverModels: (loginToken) => this.discoverModels(loginToken),
            followupAnchor: () => this.followupAnchor(),
            emitRequestEstimate: (estimate) => this.emitRequestEstimate(estimate),
            shellExecutionMode: () => this.shellExecutionMode(),
            resolveToolPath: (p) => this.resolveToolPath(p),
            safePersist: () => this.safePersist(),
            led: (role, content, extra) => this.led(role, content, extra),
            maybeAutoCompact: () => this.compactor.maybeAutoCompact(),
        });
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
        // For a brand-new (non-resumed) session, persist the store file NOW so
        // the session is visible in listSessions() immediately — before the first
        // user message. Without this, reloading the window right after opening a
        // new dialogue (but before sending) loses the session: the ledger exists
        // but the store file was never written, and listSessions() only scans the
        // store directory.
        if (!resumed) { this.safePersist(); }
        queueMicrotask(() => this.emit("event", { kind: "session", sessionId: this.sessionId, model: this.model() }));
    }

    private persist(): void {
        writeStored({
            id: this.sessionId, backend: this.backend, title: this.title,
            cwd: this.options.cwd, model: this.model(), updatedAt: new Date().toISOString(),
            messages: this.messages,
        });
    }

    public safePersist(): void {
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

    /** Keep the context meter truthful while a request is in flight. */
    private emitRequestEstimate(estimate: RequestEstimate): void {
        const model = this.model();
        this.emit("event", {
            kind: "usage",
            inputTokens: estimate.inputTokens,
            outputTokens: 0,
            totalTokens: estimate.inputTokens,
            cacheRead: 0,
            contextWindow: this.contextWindow(),
            estimated: true,
            requestChars: estimate.requestChars,
            requestMessageCount: estimate.messageCount,
            requestToolCount: estimate.toolCount,
            model,
            modelLabel: this.label(model),
            requestedModel: model,
        });
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

    private headers(loginToken?: string | null): Record<string, string> {
        return buildHeaders(this.cfg, loginToken);
    }

    /** Resolves the login token only when needed (no explicit auth configured). */
    private async authToken(): Promise<string | null> {
        return resolveAuthToken(this.cfg);
    }

    /**
     * Best-effort model discovery from <baseUrl>/models, populating the shared
     * cache so `model()` can resolve a default. Used by run() when no model is
     * selected, so the very first turn after a reload still finds a model.
     * Skipped when models are pinned in settings (the configured list wins).
     */
    private async discoverModels(loginToken?: string | null): Promise<void> {
        await discoverModelsFromCatalog(this.cfg, this.backend, loginToken);
    }

    /** Append one entry to the lossless ledger for the current turn (best-effort). */
    private led(role: string, content: unknown, extra?: Record<string, unknown>): void {
        ledger.appendMessage(this.sessionId, { role, content, turn: this.turnNo, ...extra });
    }

    send(text: string, images?: string[], preamble?: string[]): void {
        // Intercept /compact: a local command (summarize the conversation to shrink
        // the model context), NOT a user turn to ship to the gateway.
        if (text.trim().toLowerCase() === "/compact") {
            void this.compactor.compact("manual");
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
        void this.runner.run();
    }


    private shellExecutionMode(): ShellExecutionMode {
        // Per-conversation choice from the composer wins over static config,
        // so the user can flip silent/inline/terminal without changing settings.
        const cfg = this.cfg as { shellExecution?: string };
        const v = String(this.options.execDisplay ?? cfg.shellExecution ?? "silent");
        return v === "inline" || v === "terminal" ? v : "silent";
    }

    /** Resolves a tool's path argument to an absolute path against the session cwd. */
    private resolveToolPath(p: unknown): string | undefined {
        if (typeof p !== "string" || !p) { return undefined; }
        return path.isAbsolute(p) ? p : path.resolve(this.options.cwd, p);
    }

    cancel(): void {
        this.runner.cancel();
    }

    dispose(): void {
        this.runner.cancel();
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

}
