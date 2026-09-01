import { EventEmitter } from "events";
import { AgentSession, InjectedUserMessage, SessionStartOptions } from "../types";
import { HubClient } from "../../sync/hubClient";
import { ALL_AI_TOOL_NAMES } from "../aiTools/defs";
import * as ledger from "../../ledger";
import { ChatMessage, OpenAIAdapterConfig } from "./types";
import { writeStored } from "./store";
import { Compactor } from "./compactor";
import { TurnRunner } from "./turnRunner";
import { makeLogicalTurnId } from "./turnId";
import { appendUserTurn, isObjectiveText } from "./sessionSend";
import { TurnInjectionQueue } from "./turnInjection";
import { buildFollowupAnchor, OpenAISessionRuntime } from "./sessionRuntime";
import { restoreOpenAISession } from "./sessionRestore";
import { ApprovalState } from "./approvalState";

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
    /** Backend-owned pause continuation id; separate from retry attribution. */
    private pendingResumeTurnId: string | undefined;
    /** True while the next send is an explicit retry; consumed by appendUserTurn. */
    private pendingRetry = false;
    /** True only while the last turn ended at the bounded tool-hop pause. */
    private pausedForToolCap = false;
    // Continuous follow-up anchor (small-context guardrail). `objective` is the
    // current task (north star), updated on each substantive user turn; `progress`
    // is a rolling digest of tool steps taken on it. Re-injected fresh into every
    // windowed request so the model can't lose the thread mid tool-loop.
    private objective = "";
    private progress: string[] = [];
    // Last reported prompt size — feeds the compactor's auto-compact threshold.
    private lastInputTokens = 0;
    private readonly approvals: ApprovalState;
    // Context compaction + the per-turn streaming loop; both constructor-
    // initialized (they eagerly read cfg/options/sessionId).
    private readonly compactor: Compactor;
    private readonly runner: TurnRunner;
    private readonly injections = new TurnInjectionQueue();

    constructor(
        readonly backend: string,
        private readonly cfg: OpenAIAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.runtime = new OpenAISessionRuntime(this.cfg, this.options, this.backend);
        const restored = restoreOpenAISession(
            backend,
            options,
            this.cfg.model,
            this.cfg.supportsDeveloperRole !== false,
        );
        this.sessionId = restored.sessionId;
        this.messages.push(...restored.messages);
        this.title = restored.title;
        this.lineageId = restored.lineageId;
        this.turnSeq = restored.turnSeq;
        this.approvals = new ApprovalState(this.options, (event) => this.emit("event", event));
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
            emit: (event) => {
                this.emit("event", event);
            },
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
            bumpTurnNo: () => {
                this.bumpTurn();
            },
            bumpTurn: () => this.bumpTurn(),
            resumeTurn: (id) => this.resumeTurn(id),
            getResumeTurnId: () => this.pendingResumeTurnId,
            getTurnNo: () => this.turnSeq,
            getLogicalTurnId: () => this.currentLogicalTurnId,
            getIntentId: () => this.currentIntentId,
            getLastInputTokens: () => this.lastInputTokens,
            setLastInputTokens: (n) => {
                this.lastInputTokens = n;
            },
            emit: (event) => {
                this.emit("event", event);
            },
            model: () => this.runtime.model(),
            label: (id) => this.runtime.label(id),
            contextWindow: () => this.runtime.contextWindow(),
            headers: (loginToken) => this.runtime.headers(loginToken),
            authToken: () => this.runtime.authToken(),
            discoverModels: (loginToken) => this.runtime.discoverModels(loginToken),
            followupAnchor: () => buildFollowupAnchor(this.objective, this.progress),
            emitRequestEstimate: (estimate) =>
                this.emit("event", this.runtime.requestEstimateEvent(estimate)),
            shellExecutionMode: () => this.runtime.shellExecutionMode(),
            resolveToolPath: (p) => this.runtime.resolveToolPath(p),
            safePersist: () => this.safePersist(),
            led: (role, content, extra) => this.led(role, content, extra),
            maybeAutoCompact: (observedInputTokens) =>
                this.compactor.maybeAutoCompact(observedInputTokens),
            compactOnTasksComplete: () => this.compactOnTasksComplete(),
            requestApproval: (toolId, toolName, detail, tier) =>
                this.requestApproval(toolId, toolName, detail, tier),
            markPausedForContinuation: () => {
                this.pausedForToolCap = true;
            },
            injections: this.injections,
            setIntentId: (intentId) => {
                this.currentIntentId = intentId;
            },
            setObjective: (text) => {
                if (isObjectiveText(text)) {
                    this.objective = text.trim().slice(0, 600);
                }
            },
        });
        // For a brand-new (non-resumed) session, persist the store file NOW so
        // the session is visible in listSessions() immediately — before the first
        // user message. Without this, reloading the window right after opening a
        // new dialogue (but before sending) loses the session: the ledger exists
        // but the store file was never written, and listSessions() only scans the
        // store directory.
        if (!restored.resumed) {
            this.safePersist();
        }
        queueMicrotask(() =>
            this.emit("event", {
                kind: "session",
                sessionId: this.sessionId,
                model: this.runtime.model(),
            }),
        );
    }

    private persist(): void {
        writeStored({
            id: this.sessionId,
            backend: this.backend,
            title: this.title,
            cwd: this.options.cwd,
            model: this.runtime.model(),
            reasoning: this.options.reasoning,
            updatedAt: new Date().toISOString(),
            messages: this.messages,
            lineageId: this.lineageId,
        });
    }

    public safePersist(): void {
        try {
            this.persist();
        } catch (error) {
            this.emit("event", {
                kind: "error",
                message: `failed to persist session: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }

    /** Conversation lineage (groups sidebar entries; undefined = own lineage). */
    get lineage(): string | undefined {
        return this.lineageId;
    }

    /**
     * Emits an inline approval-request and waits for the webview's answer.
     * Never resolves on its own — a denied/lost turn (e.g. window reload)
     * leaves the Promise pending, which is fine: the turn is gone either way,
     * and a stale resolver is simply never called again.
     */
    private requestApproval(
        toolId: string,
        toolName: string,
        detail: string | undefined,
        tier: "write" | "destructive",
    ): Promise<boolean> {
        return this.approvals.request(toolId, toolName, detail, tier);
    }

    /** Applies a picker change immediately, including to an already-running tool loop. */
    setPermission(permission: string): void {
        this.approvals.setMode(permission);
    }

    getPermission(): string | undefined {
        return this.approvals.mode;
    }

    /** Answers a pending approval-request (called from the webview's accept/reject click). */
    resolveApproval(toolId: string, approved: boolean): void {
        this.approvals.resolve(toolId, approved);
    }

    /**
     * Compacts right now if symposium.openai.autoCompactOnTasksComplete
     * (default true) is on — called once a task_complete/TaskUpdate result
     * reports zero remaining tasks. A different trigger than the compactor's
     * own context-window-percentage check: "the unit of work just finished"
     * rather than "the prompt got big".
     */
    private async compactOnTasksComplete(): Promise<void> {
        if (this.cfg.autoCompactOnTasksComplete === false) {
            return;
        }
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
     * Continues a backend-owned pause under the same logical turn. Explicit
     * retries do not stage this id: they must get a fresh turn so late events
     * from the stalled attempt cannot terminate the recovery attempt.
     */
    private resumeTurn(resumeTurnId?: string): string {
        // Consume the staged continuation id (one-shot — cleared so it cannot
        // leak to a later turn). The turnRunner reads it via getResumeTurnId.
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
            role,
            content,
            turn: this.turnSeq,
            ...(this.currentLogicalTurnId ? { logicalTurnId: this.currentLogicalTurnId } : {}),
            ...(this.currentIntentId ? { intentId: this.currentIntentId } : {}),
            ...extra,
        });
    }

    send(
        text: string,
        images?: string[],
        preamble?: string[],
        intentId?: string,
        retryOf?: string,
    ): void {
        // Intercept /compact: a local command (summarize the conversation to shrink
        // the model context), NOT a user turn to ship to the gateway.
        if (text.trim().toLowerCase() === "/compact") {
            void this.compactor.compact("manual");
            return;
        }
        this.pausedForToolCap = false;
        // Carry the controller-assigned intent id for the ledger rows of this
        // turn (no arbiter here — the controller decides; the adapter carries it).
        this.currentIntentId = intentId;
        // A retry reuses the dangling user row, but the TurnRunner allocates a
        // fresh logicalTurnId. Reusing the old id made late cancellation events
        // indistinguishable from events belonging to this new attempt.
        this.pendingRetry = retryOf !== undefined;
        const appended = appendUserTurn(
            {
                cfg: this.cfg,
                sessionId: this.sessionId,
                messages: this.messages,
                turnSeq: this.turnSeq,
                led: (role, content, extra) => this.led(role, content, extra),
            },
            { text, images, preamble, retry: this.pendingRetry, intentId: this.currentIntentId },
        );
        this.pendingRetry = false;
        const taskText = text.trim();
        if (appended && isObjectiveText(taskText)) {
            this.objective = taskText.slice(0, 600);
            this.progress = [];
        }
        if (!this.title) {
            this.title = text.trim().slice(0, 60);
        }
        this.safePersist();
        void this.runner.run();
    }

    cancel(): void {
        this.runner.cancel();
    }
    continueTurn(): void {
        if (!this.pausedForToolCap) {
            return;
        }
        this.pausedForToolCap = false;
        this.pendingResumeTurnId = this.currentLogicalTurnId;
        void this.runner.run();
    }

    setModel(model: string): void {
        this.runtime.setModel(model);
        this.safePersist();
    }

    getModel(): string {
        return this.runtime.model();
    }

    /** See AgentSession.injectUserMessage. The TurnRunner opens the window for
     *  the duration of each run; outside one this returns false and the caller
     *  falls back to the queue. */
    injectUserMessage(message: InjectedUserMessage): boolean {
        return this.injections.offer(message);
    }

    dispose(): void {
        this.injections.closeAll("disposed");
        this.runner.cancel();
    }

    aiTools(): { available: string[]; enabled: string[] } {
        const available = [...ALL_AI_TOOL_NAMES];
        // options.aiTools: undefined = all available; [] = none; else the subset.
        const enabled =
            this.options.aiTools === undefined ? [...available] : [...this.options.aiTools];
        return { available, enabled };
    }

    setAiTools(names: string[]): void {
        // Keep only known tool names; takes effect on the next turn (run() reads
        // this.options.aiTools live).
        const known = new Set(ALL_AI_TOOL_NAMES);
        this.options.aiTools = names.filter((n) => known.has(n));
    }
}
