import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { AgentAdapter, AgentSession, SessionInfo, SessionStartOptions, TodoItem, type SessionTerminalStatus } from "../adapters/types";
import { todosSummary } from "../adapters/todos";
import { type TrackingMode } from "./outboundPrompt";
import { probeRtk } from "../adapters/rtk";
import { HubClient } from "../sync/hubClient";
import { WebviewToHost } from "./protocol";
import { RenderStream } from "./renderStream";
import { transcriptText, transcriptMessages, transcriptMessagesUpTo } from "./controllerTranscript";
import { ChatQueue, MessageDedup, PendingMessage, SendMode } from "./controllerQueue";
import { ChangedFilesState } from "./changedFilesState";
import { handleControllerMessage } from "./controllerMessageHandler";
import { HubState, HubStateContext, reloadGuardrails as reloadHubGuardrails, reloadTasks as reloadHubTasks, pendingTasksSummary as hubPendingTasksSummary } from "./controllerHubState";
import { WatchdogContext, armWatchdog as armWatchdogFn, clearWatchdog as clearWatchdogFn } from "./controllerWatchdog";
import { persistEmit as persistEmitFn, seedRenderLog as seedRenderLogFn } from "./controllerPersist";
import { OutboundPromptState } from "./outboundPrompt";
import { buildDispatchOutbound } from "./controllerDispatchPrompt";
import { prepareDispatch } from "./controllerDispatchPrep";
import { ControllerEventHandler } from "./controllerEventHandler";
import { loadControllerHistory } from "./controllerHistory";
import { stableSessionKey } from "./sessionIdentity";

/** Owns one live dialogue process; view switches only detach/replay the stream. */
export class ChatController {
    private session: AgentSession | undefined;
    private busy = false;
    // Set on any fatal error this turn (dispatch-setup failure, or a fatal
    // AgentEvent) and reset when a new turn starts. Gates auto-draining the
    // queue on turn-end: a failed turn must never silently swallow a queued
    // message as if it were a normal continuation — the user gets to choose
    // Retry or explicitly promote/steer the queued item instead.
    /** Last terminal warning/error, cleared when a new turn starts. */ public attentionStatus: SessionTerminalStatus | undefined;
    private firstTitle = "";
    // One-shot outbound-prompt injection flags (policy/todo/seed/rtk/...),
    // read + written by buildDispatchOutbound() each dispatch() call.
    private readonly promptState: OutboundPromptState = {
        policyInjected: false, todoInjected: false, seedInjected: false, autonomyInjected: false,
        rtkInjected: false, sessionIdInjected: false, bootstrapInjected: false, checkpointInjected: false,
        trackingInjected: false,
    };
    // Latest native/fence TodoWrite state (Claude/Codex/Copilot/OpenAI-fence).
    // Unlike Hub tasks, this has no server-side reminder of its own — feeds
    // pendingTasksSummary() below so the agent is re-told its current step on
    // every message, not just the turn that first stated the plan.
    private lastTodos: TodoItem[] = [];
    // Set at the top of every dispatch() — see its use in onEvent() below.
    private trackingMode: TrackingMode | undefined;
    private readonly hub = new HubClient();
    // Id of the session checkpoint already injected as resume context, so the
    // same one isn't re-prepended every continuity turn.
    private injectedCheckpointId: string | undefined;

    private readonly changed = new ChangedFilesState();
    private readonly queue = new ChatQueue();
    // Replayable render-message buffer + webview sink + read-only followers.
    // Every emitted message is also persisted (per session) so a reopened session
    // replays its exact visual — tool rows, diffs, status notices, panels, all of it.
    private readonly stream = new RenderStream((m) => this.persistEmit(m));
    // Watchdog timer state (see controllerWatchdog): force-ends a silent turn so
    // a stalled tool/dropped connection can't pin the session as "working".
    private readonly watchdogState = { timer: undefined as ReturnType<typeof setTimeout> | undefined };

    // Shared mutable state for the extracted helper modules (controllerPersist,
    // controllerHubState). The controller reads/writes these directly.
    private readonly persistState = { count: 0 };
    private readonly hubState: HubState = { guardrails: [], guardrailsLoaded: false, pendingTasks: [] };
    /**
     * Host-side idempotency: a clientMessageId already accepted is not processed
     * again (no second dispatch/enqueue/tool run). See MessageDedup.
     */
    private readonly dedup = new MessageDedup();
    /**
     * The stable logicalTurnId of the most recent turn (from the turn-start
     * event emitted by the adapter). Used by Retry to tell the adapter to REUSE
     * this id instead of allocating a new one — so a retried turn is attributable
     * to the original for observability (delivery 1C).
     */
    private lastLogicalTurnId: string | undefined;
    private readonly eventHandler = new ControllerEventHandler({
        isBusy: () => this.busy, setBusy: (busy) => { this.busy = busy; },
        armWatchdog: () => this.armWatchdog(), clearWatchdog: () => this.clearWatchdog(),
        emit: (message) => this.emit(message), statusChanged: () => this.onStatusChange?.(),
        recordChanged: (file, added, removed) => { this.changed.record(file, added, removed); this.emitChanged(); },
        setTodos: (todos) => { this.lastTodos = todos; }, trackingMode: () => this.trackingMode,
        markTurnFailed: () => { this.attentionStatus = "error"; }, markTurnWarning: () => { this.attentionStatus = "warning"; }, turnFailed: () => this.attentionStatus === "error",
        setLogicalTurnId: (id) => { this.lastLogicalTurnId = id; }, takeQueued: () => this.queue.shift(),
        emitQueue: () => this.emitQueue(), dispatch: (message) => { void this.dispatch(message); },
    });

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        // Fired when the running/idle state changes.
        private readonly onStatusChange?: () => void,
    ) {
        // Probe rtk once so the preamble is only injected when callable.
        void probeRtk(options.cwd);
    }

    get sessionId(): string | undefined {
        return this.session?.sessionId ?? this.options.resumeSessionId;
    }

    get sessionKey(): string | undefined { return stableSessionKey(this.options.resumeSessionId, this.session?.sessionId); }

    /** True while a turn is running (agent working). */
    get isBusy(): boolean {
        return this.busy;
    }

    /** The stable logicalTurnId of the last turn (for Retry reuse), or undefined. */
    get lastTurnId(): string | undefined {
        return this.lastLogicalTurnId;
    }

    /** (Re)arms the silence watchdog while busy; no-op when idle. */
    private armWatchdog(): void {
        armWatchdogFn(this.watchdogContext(), this.watchdogState);
    }

    private clearWatchdog(): void {
        clearWatchdogFn(this.watchdogState);
    }

    private watchdogContext(): WatchdogContext {
        return {
            busy: () => this.busy,
            setBusy: (v) => { this.busy = v; },
            markTurnFailed: () => { this.attentionStatus = "error"; },
            cancel: () => this.session?.cancel(),
            onStatusChange: () => this.onStatusChange?.(),
            emit: (m) => this.emit(m),
            silenceMinutes: () => vscode.workspace.getConfiguration("symposium").get<number>("turnSilenceMinutes", 5),
        };
    }

    private hubContext(): HubStateContext {
        return { sessionId: () => this.sessionId, hub: () => this.hub, state: this.hubState };
    }

    get backend(): string { return this.adapter.backend; }
    get cwd(): string { return this.options.cwd; }
    /** Parent session id when this controller drives a spawned subagent. */
    get parentId(): string | undefined { return this.options.parentId; }
    /** Conversation lineage this session belongs to (sidebar grouping; undefined = own). */
    get lineageId(): string | undefined { return this.options.lineageId; }
    /** First user message, used as a title for a not-yet-persisted live session. */
    get title(): string { return this.firstTitle || "New session"; }

    /** Define o modelo para a próxima mensagem da sessão atual. */
    setModel(model: string): void {
        this.options.model = model === "default" ? undefined : model;
        this.session?.setModel?.(model);
    }
    /** Retorna o modelo atual da sessão. */
    getModel(): string { return this.session?.getModel?.() || this.options.model || ""; }

    /** Plain-text user/assistant exchange, for backend handoff. */
    transcript(): string { return transcriptText(this.stream.messages); }
    /** Renderable user/assistant rows, for repainting prior exchange. */
    transcriptMessages(): { role: "user" | "assistant"; text: string }[] { return transcriptMessages(this.stream.messages); }
    /** Visible user/assistant rows up to and including `index` (0-based). */
    transcriptMessagesUpTo(index: number): { role: "user" | "assistant"; text: string }[] { return transcriptMessagesUpTo(this.stream.messages, index); }
    /** Plain-text transcript up to and including `index` (0-based conversation-row index). */
    transcriptUpTo(index: number): string {
        const rows = transcriptMessagesUpTo(this.stream.messages, index);
        return rows.map((r) => `${r.role === "user" ? "user" : "assistant"}: ${r.text}`).join("\n\n");
    }

    get attached(): boolean { return this.stream.hasSink; }
    /** Retorna a sessão atual do AgentAdapter para acesso direto. */
    getSession(): AgentSession | undefined { return this.session; }

    /** Binds this controller to one webview sink and replays its render log. */
    attach(sink: (message: unknown) => void): () => void {
        // A controller that was already busy before this attach (e.g. survived a
        // reload) may have no watchdog armed — re-arm so a stalled turn still
        // self-heals instead of showing "working" forever.
        if (this.busy && !this.watchdogState.timer) { this.armWatchdog(); }
        const detach = this.stream.bindSink(sink);
        // The edited-files set is controller state (not in the replay log), so
        // push it after replay — this is what keeps approvals from "coming back"
        // when switching away and back.
        this.emitChanged();
        return detach;
    }

    subscribe(observer: (message: unknown) => void): () => void { return this.stream.addObserver(observer); }
    private emit(message: unknown): void { this.stream.emit(message); }

    sendText(text: string, mode: SendMode = "send"): void { this.onSend({ text, attachments: [] }, mode); }

    interrupt(): void { this.session?.cancel(); }
    continueTurn(): void {
        const session = this.session;
        if (this.busy || !session?.continueTurn) return;
        this.busy = true;
        this.attentionStatus = undefined; this.onStatusChange?.(); session.continueTurn();
    }

    aiToolsInfo(): { available: string[]; enabled: string[] } | undefined { return this.session?.aiTools?.(); }

    setAiTools(names: string[]): void { this.session?.setAiTools?.(names); }
    /** Persists newly-emitted render messages (see controllerPersist). */
    private persistEmit(message: unknown): void {
        persistEmitFn({ sessionId: () => this.sessionId, stream: this.stream, state: this.persistState }, message);
    }

    /** Restores a reopened session's render log from disk (see controllerPersist). */
    seedRenderLog(): boolean {
        const restored = seedRenderLogFn({ sessionId: () => this.sessionId, stream: this.stream, state: this.persistState }, this.options.resumeSessionId);
        this.queue.restore(restored.pending);
        return restored.seeded;
    }

    async loadHistory(info: SessionInfo): Promise<void> {
        await loadControllerHistory(this.adapter, info, (message) => this.emit(message));
    }

    async handleMessage(message: WebviewToHost): Promise<boolean> {
        return handleControllerMessage(message, {
            busy: () => this.busy,
            cancel: () => this.session?.cancel(),
            continueTurn: () => this.continueTurn(),
            queue: this.queue,
            stream: this.stream,
            emitQueue: () => this.emitQueue(),
            dispatch: (queued) => { void this.dispatch(queued); },
            onSend: (pending, mode) => this.onSend(pending, mode),
            resolveApproval: (toolId, approved) => this.session?.resolveApproval?.(toolId, approved),
        });
    }

    private onSend(msg: PendingMessage, mode: SendMode): void {
        msg.mode = mode;
        // Idempotency: a clientMessageId already seen means this is a transport
        // double-delivery / reconnect replay of a message the host already
        // accepted. Drop it silently — no second dispatch, no second enqueue, no
        // second tool execution. The webview already reconciled its optimistic
        // bubble on the first acceptance.
        if (!this.dedup.accept(msg.clientMessageId)) { return; }
        // Redirect (delivery 1D): like steer, cancel the running turn so the
        // correction dispatches next — but UNLIKE steer, keep the existing queue
        // (steer clears it) and front-insert the redirect so it runs before any
        // already-queued work. The correction is not a separate "do later" intent.
        // BUT: a redirect carrying a clear cancellation signal ("stop", "don't",
        // "never", "cancel") invalidates the queued future work too — a stale
        // queued task that re-arms cancelled work is the defect 1.1.
        if (mode === "redirect" && this.busy) {
            const isCancel = /\b(stop|cancel|don'?t|never|pare|cancela|n[ãa]o)\b/i.test(msg.text);
            if (isCancel) { this.queue.clear(); }
            this.queue.unshift(msg);
            this.session?.cancel();
            this.emitQueue();
            return;
        }
        if (mode === "steer" && this.busy) {
            this.queue.clear();
            this.queue.push(msg);
            this.session?.cancel();
            return;
        }
        if (this.busy) {
            this.queue.enqueue(msg);
            this.emitQueue();
            return;
        }
        void this.dispatch(msg);
    }

    /** Full queue state (editable until dispatched), reflected in the webview. */
    private emitQueue(): void {
        this.emit({ type: "queue", items: this.queue.items() });
    }

    /** (Re)loads the session's user guardrails into the per-message cache. */
    async reloadGuardrails(): Promise<void> {
        await reloadHubGuardrails(this.hubContext());
    }

    /** (Re)loads pending tasks and generates a reminder summary. */
    private async reloadTasks(): Promise<void> {
        await reloadHubTasks(this.hubContext());
    }

    /**
     * Builds a per-message reminder of what's still open. Hub tasks (OpenAI w/
     * Hub, "hub-tools" mode) take priority when present; otherwise falls back to
     * the locally-tracked native/fence plan (Claude/Codex/Copilot/OpenAI-fence),
     * which has no server-side reminder of its own — see `lastTodos` above.
     */
    private pendingTasksSummary(): string | undefined {
        return hubPendingTasksSummary(this.hubContext()) ?? todosSummary(this.lastTodos);
    }

    private async dispatch(msg: PendingMessage): Promise<void> {
        // Gate concurrent sends before any awaited pre-dispatch work.
        this.busy = true;
        this.attentionStatus = undefined;
        this.onStatusChange?.();
        try {
            await prepareDispatch(
                {
                    adapter: this.adapter,
                    sessionId: this.sessionId,
                    hub: this.hub,
                    options: this.options,
                    reloadGuardrails: () => this.reloadGuardrails(),
                    reloadTasks: () => this.reloadTasks(),
                    getInjectedCheckpointId: () => this.injectedCheckpointId,
                    setInjectedCheckpointId: (id) => { this.injectedCheckpointId = id; },
                },
                msg,
            );
            if (!this.session) {
                this.session = this.adapter.start(this.options);
                this.session.on("event", this.eventHandler.handle);
            }
            const { text: outboundText, preamble: outboundPreamble, trackingMode, images } = buildDispatchOutbound(
                {
                    adapter: this.adapter,
                    sessionId: this.sessionId,
                    options: this.options,
                    hubState: this.hubState,
                    aiToolsInfo: () => this.aiToolsInfo(),
                    pendingTasksSummary: () => this.pendingTasksSummary(),
                    promptState: this.promptState,
                },
                msg,
            );
            // onEvent() (a separate, later-firing method) needs this to gate the
            // fence-parsing fallback — see its use below.
            this.trackingMode = trackingMode;
            if (!this.firstTitle && msg.text.trim()) { this.firstTitle = msg.text.trim().slice(0, 60); }
            this.armWatchdog();
            // A plain-retry resend (msg.interruptedBy set) re-sends the SAME
            // text already visible in an earlier bubble — rendering it again
            // would just duplicate it; the status-notice (with an anchor back
            // to that bubble) is the visible signal instead.
            if (!msg.interruptedBy) {
                this.emit({ type: "user", text: msg.text, attachments: msg.attachments, clientMessageId: msg.clientMessageId });
            }
            // Assign a stable intent id for this user request (unless the
            // webview/sender already provided one) and carry it into the turn so
            // the ledger rows are attributable to a single intent. No arbiter
            // here — every message gets its own fresh intent; reuse across
            // retry/redirect is a later concern.
            const intentId = msg.intentId ?? randomUUID();
            // Retry (delivery 1C): when retryOf is set, tell the adapter to reuse
            // the original logicalTurnId instead of allocating a new one.
            // Speech-to-text: inject a developer-role note when the message
            // originated from voice transcription (may contain errors).
            const finalPreamble = msg.speech
                ? [...outboundPreamble, "[Speech input] This message was transcribed from speech and may contain errors in names, identities, technical terms, or words in other languages. Interpret liberally — do not treat unknown words as literal instructions or identifiers."]
                : outboundPreamble;
            this.session.send(outboundText, images, finalPreamble, intentId, msg.retryOf);
        } catch (error) {
            // Any failure before turn-end (adapter start, prompt build, transcript
            // persistence, process spawn setup) must never leave the controller
            // permanently busy — but it also must NOT silently auto-send whatever
            // is queued next (that would swallow a queued message as if it were a
            // normal continuation of a failed turn). Surface the error and stop;
            // the user chooses Retry or explicitly promotes/steers the queue.
            this.busy = false;
            this.attentionStatus = "error";
            this.clearWatchdog();
            this.onStatusChange?.();
            this.emit({ type: "event", event: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
        }
    }

    /** Signals the surface to re-derive the displayed edited-files set. */
    private emitChanged(): void {
        this.stream.toSink({ type: "changed-files", items: this.changedItemsRaw() });
    }

    /** Paths still pending review (for bulk approve/reject). */
    changedPaths(): string[] {
        return this.changed.paths();
    }

    /** The raw edited-files set (before git-status filtering by the surface). */
    changedItemsRaw(): { path: string; added: number; removed: number }[] {
        return this.changed.items();
    }

    /** Drops a file from the set after it's approved or reverted. */
    resolveChanged(path: string): void {
        if (this.changed.resolve(path)) { this.emitChanged(); }
    }

    dispose(): void {
        this.clearWatchdog();
        this.session?.dispose();
        this.session = undefined;
        this.queue.clear();
    }
}
