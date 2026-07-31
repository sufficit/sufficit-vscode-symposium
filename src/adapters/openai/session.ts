import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { AgentSession, SessionStartOptions } from "../types";
import { HubClient } from "../../sync/hubClient";
import { ALL_AI_TOOL_NAMES } from "../aiTools";
import * as ledger from "../../ledger";
import { ChatMessage, ContentPart, OpenAIAdapterConfig } from "./types";
import { readStored, writeStored } from "./store";
import { Compactor } from "./compactor";
import { TurnRunner } from "./turnRunner";
import { makeLogicalTurnId, parseTurnSeq } from "./turnId";
import { buildTimeGapNotice } from "./timeGapNotice";
import { buildImageParts } from "./imageParts";
import { buildFollowupAnchor, OpenAISessionRuntime } from "./sessionRuntime";

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
    /** Conversation lineage inherited at branch time (groups sidebar entries). */
    private lineageId: string | undefined;
    private readonly hub = new HubClient();
    private readonly runtime: OpenAISessionRuntime;
    /**
     * Monotonic logical-turn sequence, stable across retries and reopen
     * (reconstructed from meta.json/ledger on resume, unlike the old turnNo
     * which reset to 0 on every reopen). The visible turn number exposed to
     * the UI and the legacy ledger `turn` field derive from this.
     */
    private turnSeq = 0;
    /** Stable id of the in-flight logical turn (sessionId/turn-<seq>), or undefined between turns. */
    private currentLogicalTurnId: string | undefined;
    /** Intent id propagated from the controller for the in-flight turn (no arbiter here — carried, not decided). */
    private currentIntentId: string | undefined;
    /** logicalTurnId to reuse for a Retry (set by send when resumeTurnId is passed); consumed once by resumeTurn(). */
    private pendingResumeTurnId: string | undefined;
    // Continuous follow-up anchor (small-context guardrail). `objective` is the
    // current task (north star), updated on each substantive user turn; `progress`
    // is a rolling digest of tool steps taken on it. Re-injected fresh into every
    // windowed request so the model can't lose the thread mid tool-loop.
    private objective = "";
    private progress: string[] = [];
    // Last reported prompt size — feeds the compactor's auto-compact threshold.
    private lastInputTokens = 0;
    // Inline tool-approval gate (admin/manager/user modes): one pending
    // resolver per in-flight "approval-request", keyed by toolId. The turn
    // loop awaits requestApproval() and blocks until resolveApproval() (fired
    // by the webview's accept/reject click) resolves the matching entry.
    private pendingApprovals = new Map<string, (approved: boolean) => void>();
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
        this.runtime = new OpenAISessionRuntime(this.cfg, this.options, this.backend);
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
        // Lineage: an explicit branch option wins; else inherit the resumed
        // session's lineage; else this session starts a fresh conversation.
        this.lineageId = options.lineageId ?? resumed?.lineageId;
        // Reconstruct the monotonic logical-turn sequence so reopening does NOT
        // restart turn numbering at 0. Prefer the persisted nextTurnSeq in
        // meta.json (canonical); fall back to the max seq embedded in the
        // ledger's logicalTurnId fields so even a hand-restored/partial ledger
        // converges. A brand-new session leaves turnSeq at 0.
        if (ledger.hasLedger(this.sessionId)) {
            const meta = ledger.readMeta(this.sessionId);
            const fromMeta = typeof meta?.nextTurnSeq === "number" ? meta.nextTurnSeq - 1 : 0;
            let fromLedger = 0;
            for (const m of ledger.readMessages(this.sessionId)) {
                const seq = parseTurnSeq(m.logicalTurnId as string | undefined);
                if (seq && seq > fromLedger) { fromLedger = seq; }
            }
            this.turnSeq = Math.max(fromMeta, fromLedger);
        }
        this.compactor = new Compactor({
            cfg: this.cfg,
            sessionId: this.sessionId,
            getMessages: () => this.messages,
            getTurnNo: () => this.turnSeq,
            getLastInputTokens: () => this.lastInputTokens,
            model: () => this.runtime.model(),
            contextWindow: () => this.runtime.contextWindow(),
            authToken: () => this.runtime.authToken(),
            headers: (loginToken) => this.runtime.headers(loginToken),
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
            bumpTurnNo: () => { this.bumpTurn(); },
            bumpTurn: () => this.bumpTurn(),
            resumeTurn: (id) => this.resumeTurn(id),
            getResumeTurnId: () => this.pendingResumeTurnId,
            getTurnNo: () => this.turnSeq,
            getLogicalTurnId: () => this.currentLogicalTurnId,
            getIntentId: () => this.currentIntentId,
            getLastInputTokens: () => this.lastInputTokens,
            setLastInputTokens: (n) => { this.lastInputTokens = n; },
            emit: (event) => { this.emit("event", event); },
            model: () => this.runtime.model(),
            label: (id) => this.runtime.label(id),
            contextWindow: () => this.runtime.contextWindow(),
            headers: (loginToken) => this.runtime.headers(loginToken),
            authToken: () => this.runtime.authToken(),
            discoverModels: (loginToken) => this.runtime.discoverModels(loginToken),
            followupAnchor: () => buildFollowupAnchor(this.objective, this.progress),
            emitRequestEstimate: (estimate) => this.emit("event", this.runtime.requestEstimateEvent(estimate)),
            shellExecutionMode: () => this.runtime.shellExecutionMode(),
            resolveToolPath: (p) => this.runtime.resolveToolPath(p),
            safePersist: () => this.safePersist(),
            led: (role, content, extra) => this.led(role, content, extra),
            maybeAutoCompact: (observedInputTokens) => this.compactor.maybeAutoCompact(observedInputTokens),
            compactOnTasksComplete: () => this.compactOnTasksComplete(),
            requestApproval: (toolId, toolName, detail, tier) => this.requestApproval(toolId, toolName, detail, tier),
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
        queueMicrotask(() => this.emit("event", { kind: "session", sessionId: this.sessionId, model: this.runtime.model() }));
    }

    private persist(): void {
        writeStored({
            id: this.sessionId, backend: this.backend, title: this.title,
            cwd: this.options.cwd, model: this.runtime.model(), updatedAt: new Date().toISOString(),
            messages: this.messages, lineageId: this.lineageId,
        });
    }

    public safePersist(): void {
        try {
            this.persist();
        } catch (error) {
            this.emit("event", { kind: "error", message: `failed to persist session: ${error instanceof Error ? error.message : String(error)}` });
        }
    }

    /** Conversation lineage (groups sidebar entries; undefined = own lineage). */
    get lineage(): string | undefined { return this.lineageId; }

    private ledgerMeta(): import("../../ledger").LedgerMeta {
        return {
            id: this.sessionId, backend: this.backend, title: this.title,
            cwd: this.options.cwd, model: this.runtime.model(),
            reasoning: this.options.reasoning,
        };
    }

    /**
     * Emits an inline approval-request and waits for the webview's answer.
     * Never resolves on its own — a denied/lost turn (e.g. window reload)
     * leaves the Promise pending, which is fine: the turn is gone either way,
     * and a stale resolver is simply never called again.
     */
    private requestApproval(toolId: string, toolName: string, detail: string | undefined, tier: "write" | "destructive"): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.pendingApprovals.set(toolId, resolve);
            this.emit("event", { kind: "approval-request", toolId, toolName, detail, tier });
        });
    }

    /** Answers a pending approval-request (called from the webview's accept/reject click). */
    resolveApproval(toolId: string, approved: boolean): void {
        const resolve = this.pendingApprovals.get(toolId);
        if (!resolve) { return; }
        this.pendingApprovals.delete(toolId);
        resolve(approved);
        this.emit("event", { kind: "approval-resolved", toolId, approved });
    }

    /**
     * Compacts right now if symposium.openai.autoCompactOnTasksComplete
     * (default true) is on — called once a task_complete/TaskUpdate result
     * reports zero remaining tasks. A different trigger than the compactor's
     * own context-window-percentage check: "the unit of work just finished"
     * rather than "the prompt got big".
     */
    private async compactOnTasksComplete(): Promise<void> {
        if (this.cfg.autoCompactOnTasksComplete === false) { return; }
        await this.compactor.compact("auto");
    }

    /**
     * Advances to the next logical turn: increments the monotonic seq (stable
     * across reopen), assigns the stable logicalTurnId, and persists the next
     * seq to meta.json so a reload resumes numbering correctly. Returns the new
     * logicalTurnId. Replaces the old `this.turnNo++` that reset on every reopen.
     */
    private bumpTurn(): string {
        this.turnSeq++;
        this.currentLogicalTurnId = makeLogicalTurnId(this.sessionId, this.turnSeq);
        // Persist the next seq so resume doesn't restart at 0 (best-effort).
        ledger.writeMeta(this.sessionId, { nextTurnSeq: this.turnSeq + 1 });
        return this.currentLogicalTurnId;
    }

    /**
     * Reuses an existing logicalTurnId for a RETRY (delivery 1C): instead of
     * allocating a fresh turn, the adapter continues under the same stable id so
     * the retry is attributable to the original turn for observability. Does NOT
     * increment the turn seq (it's the same logical turn) — but attemptIds
     * continue advancing (the turnRunner assigns them per-hop). Falls back to a
     * fresh bumpTurn when the id is absent/invalid (e.g. after a reload).
     */
    private resumeTurn(resumeTurnId?: string): string {
        // Consume the staged retry id (one-shot — cleared so it can't leak to a
        // later turn). The turnRunner reads it via getResumeTurnId before calling.
        const id = resumeTurnId ?? this.pendingResumeTurnId;
        this.pendingResumeTurnId = undefined;
        // Validate the id belongs to THIS session and matches the expected format,
        // not just any string containing "/turn-" (defect 4.3: a foreign id could
        // hijack the logicalTurnId namespace via the untrusted webview retryOf).
        if (typeof id === "string" && id.startsWith(this.sessionId + "/turn-")) {
            this.currentLogicalTurnId = id;
            return id;
        }
        return this.bumpTurn();
    }

    /** Append one entry to the lossless ledger for the current turn (best-effort). */
    private led(role: string, content: unknown, extra?: Record<string, unknown>): void {
        ledger.appendMessage(this.sessionId, {
            role, content, turn: this.turnSeq,
            ...(this.currentLogicalTurnId ? { logicalTurnId: this.currentLogicalTurnId } : {}),
            ...(this.currentIntentId ? { intentId: this.currentIntentId } : {}),
            ...extra,
        });
    }

    send(text: string, images?: string[], preamble?: string[], intentId?: string, resumeTurnId?: string): void {
        // Intercept /compact: a local command (summarize the conversation to shrink
        // the model context), NOT a user turn to ship to the gateway.
        if (text.trim().toLowerCase() === "/compact") {
            void this.compactor.compact("manual");
            return;
        }
        // Carry the controller-assigned intent id for the ledger rows of this
        // turn (no arbiter here — the controller decides; the adapter carries it).
        this.currentIntentId = intentId;
        // Retry (1C): the logicalTurnId to reuse is staged here and consumed once
        // by resumeTurn() at the start of the turn.
        this.pendingResumeTurnId = resumeTurnId;
        // One-shot app instructions (todo capability, autonomy, policy) go in as
        // `developer` messages — above the user turn, below the preset's system —
        // instead of being glued onto the user text. Downgraded to `system` for
        // gateways that don't accept the developer role.
        const role = this.cfg.supportsDeveloperRole !== false ? "developer" : "system";
        // If the previous turn was interrupted (steer/cancel) it left a dangling
        // user message with no assistant reply. Sending another user message would
        // break role alternation (Anthropic-backed providers 400 on user→user).
        // Close the gap with a short assistant turn so the new user is valid.
        // BUT: a Retry (resumeTurnId set) of a failed turn leaves the same user
        // message dangling — re-pushing it would duplicate it in model context
        // and the lossless ledger (defect 4.1). When retrying and the dangling
        // last message is textually identical, reuse it instead of re-pushing.
        const last = this.messages[this.messages.length - 1];
        const lastText = last && typeof last.content === "string" ? last.content : "";
        const isRetryReuse = typeof resumeTurnId === "string" && last && last.role === "user" && lastText === text;
        if (last && last.role === "user" && !isRetryReuse) {
            this.messages.push({ role: "assistant", content: "(previous turn interrupted)" });
            this.led("assistant", "(previous turn interrupted)");
        }
        const gapNote = buildTimeGapNotice(this.cfg, this.sessionId);
        const fullPreamble = gapNote ? [gapNote, ...(preamble ?? [])] : (preamble ?? []);
        for (const p of fullPreamble) {
            if (p && p.trim()) {
                this.messages.push({ role, content: p });
                ledger.appendMessage(this.sessionId, { role, content: p, turn: this.turnSeq + 1 });
            }
        }
        const imageParts = buildImageParts(images);
        const userContent: string | ContentPart[] = imageParts.length
            ? [{ type: "text", text }, ...imageParts]
            : text;
        // A Retry of a failed turn reuses the dangling user message already in
        // context + ledger (isRetryReuse). Don't push/append a second copy — the
        // model and the lossless ledger must see the request exactly once, and a
        // multi-retry loop must not compound duplicates (defect 4.1).
        if (!isRetryReuse) {
            this.messages.push({ role: "user", content: userContent });
            const taskText = text.trim();
            if (taskText.length >= 8 && !/^(continue|continuar|segue|prossiga|go on|keep going|ok|sim|yes|y)\b/i.test(taskText)) {
                this.objective = taskText.slice(0, 600);
                this.progress = [];
            }
            ledger.appendMessage(this.sessionId, {
                role: "user",
                content: imageParts.length ? `${text}\n[${imageParts.length} image(s) attached]` : text,
                turn: this.turnSeq + 1,
                // The user message anticipates the upcoming turn (bumpTurn runs in
                // run()). Stamp the intent now so the row carries it even though the
                // logicalTurnId is assigned when the turn actually starts.
                ...(this.currentIntentId ? { intentId: this.currentIntentId } : {}),
            });
        }
        if (!this.title) { this.title = text.trim().slice(0, 60); }
        this.safePersist();
        void this.runner.run();
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
