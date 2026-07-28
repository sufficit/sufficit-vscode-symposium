import * as vscode from "vscode";
import { AgentAdapter, AgentEvent, AgentSession, SessionInfo, SessionStartOptions, TodoItem } from "../adapters/types";
import { parseTodoFence, todosSummary } from "../adapters/todos";
import { type TrackingMode } from "./outboundPrompt";
import { probeRtk } from "../adapters/rtk";
import { HubClient } from "../sync/hubClient";
import { WebviewToHost } from "./protocol";
import { RenderStream } from "./renderStream";
import { transcriptText, transcriptMessages, transcriptMessagesUpTo } from "./controllerTranscript";
import { ChatQueue, PendingMessage, SendMode } from "./controllerQueue";
import { ChangedFilesState } from "./changedFilesState";
import { handleControllerMessage } from "./controllerMessageHandler";
import { HubState, HubStateContext, reloadGuardrails as reloadHubGuardrails, reloadTasks as reloadHubTasks, pendingTasksSummary as hubPendingTasksSummary } from "./controllerHubState";
import { WatchdogContext, armWatchdog as armWatchdogFn, clearWatchdog as clearWatchdogFn } from "./controllerWatchdog";
import { persistEmit as persistEmitFn, seedRenderLog as seedRenderLogFn } from "./controllerPersist";
import { OutboundPromptState } from "./outboundPrompt";
import { buildDispatchOutbound } from "./controllerDispatchPrompt";
import { prepareDispatch } from "./controllerDispatchPrep";

/** Owns one live dialogue process; view switches only detach/replay the stream. */
export class ChatController {
    private session: AgentSession | undefined;
    private busy = false;
    // Set on any fatal error this turn (dispatch-setup failure, or a fatal
    // AgentEvent) and reset when a new turn starts. Gates auto-draining the
    // queue on turn-end: a failed turn must never silently swallow a queued
    // message as if it were a normal continuation — the user gets to choose
    // Retry or explicitly promote/steer the queued item instead.
    private turnHadError = false;
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

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        // Fired when the running/idle state changes, so the sessions list can
        // update its per-session working indicator.
        private readonly onStatusChange?: () => void,
    ) {
        // Probe rtk once so the RTK preamble is only injected (costing tokens)
        // when rtk is actually callable in the tool shell. Re-probeable from the UI.
        void probeRtk(options.cwd);
    }

    /** The live session id, once the backend has reported it. */
    get sessionId(): string | undefined {
        return this.session?.sessionId ?? this.options.resumeSessionId;
    }

    /** True while a turn is running (agent working). */
    get isBusy(): boolean {
        return this.busy;
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
            markTurnFailed: () => { this.turnHadError = true; },
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
    getModel(): string { return this.options.model || ""; }

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

    /** Subscribes a read-only follower (remote viewer) to the render stream. */
    subscribe(observer: (message: unknown) => void): () => void { return this.stream.addObserver(observer); }

    private emit(message: unknown): void { this.stream.emit(message); }

    /** Sends a message to this session programmatically (public API / bridge). */
    sendText(text: string, mode: SendMode = "send"): void { this.onSend({ text, attachments: [] }, mode); }

    /** Interrupts the running turn, if any (public API / bridge). */
    interrupt(): void { this.session?.cancel(); }

    /** Per-session tool gating (native AI backend only; undefined elsewhere). */
    aiToolsInfo(): { available: string[]; enabled: string[] } | undefined { return this.session?.aiTools?.(); }

    setAiTools(names: string[]): void { this.session?.setAiTools?.(names); }

    /** Persists newly-emitted render messages (see controllerPersist). */
    private persistEmit(message: unknown): void {
        persistEmitFn({ sessionId: () => this.sessionId, stream: this.stream, state: this.persistState }, message);
    }

    /** Restores a reopened session's render log from disk (see controllerPersist). */
    seedRenderLog(): boolean {
        return seedRenderLogFn({ sessionId: () => this.sessionId, stream: this.stream, state: this.persistState }, this.options.resumeSessionId);
    }

    async loadHistory(info: SessionInfo): Promise<void> {
        if (!this.adapter.history) {
            return;
        }
        try {
            const messages = await this.adapter.history(info);
            this.emit({ type: "history", messages });
        } catch (error) {
            this.emit({
                type: "event",
                event: { kind: "error", message: `failed to load history: ${error instanceof Error ? error.message : error}` },
            });
        }
    }

    async handleMessage(message: WebviewToHost): Promise<boolean> {
        return handleControllerMessage(message, {
            busy: () => this.busy,
            cancel: () => this.session?.cancel(),
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
        this.turnHadError = false;
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
                this.session.on("event", (event: AgentEvent) => this.onEvent(event));
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
            this.session.send(outboundText, images, outboundPreamble);
        } catch (error) {
            // Any failure before turn-end (adapter start, prompt build, transcript
            // persistence, process spawn setup) must never leave the controller
            // permanently busy — but it also must NOT silently auto-send whatever
            // is queued next (that would swallow a queued message as if it were a
            // normal continuation of a failed turn). Surface the error and stop;
            // the user chooses Retry or explicitly promotes/steers the queue.
            this.busy = false;
            this.clearWatchdog();
            this.onStatusChange?.();
            this.emit({ type: "event", event: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
        }
    }

    private onEvent(event: AgentEvent): void {
        // Any backend activity proves the turn is alive — push the watchdog out.
        if (this.busy) { this.armWatchdog(); }
        this.emit({ type: "event", event });
        if (event.kind === "session") {
            this.onStatusChange?.();
        }
        // Track edited files here (authoritative, survives view switches).
        if (event.kind === "tool-start" && event.path && (event.added != null || event.removed != null)) {
            this.changed.record(event.path, event.added, event.removed);
            this.emitChanged();
        }
        // Remember the latest native TodoWrite/update_plan state — see lastTodos.
        if ((event.kind === "tool-start" || event.kind === "tool-end") && event.todos) {
            this.lastTodos = event.todos;
        }
        // Fence mode only: a hub-tools session already tracks its plan via
        // add_task/task_complete, so a stray ```todo block in its text (the
        // model isn't instructed to emit one, but nothing stops it) must not
        // also spawn a second, redundant plan-card.
        if (event.kind === "text" && this.trackingMode === "fence") {
            const todos = parseTodoFence(event.text);
            if (todos) {
                this.lastTodos = todos;
                this.emit({ type: "event", event: { kind: "tool-start", toolName: "TodoWrite", detail: "", todos } });
            }
        }
        if (event.kind === "error" && event.fatal !== false) {
            this.turnHadError = true;
        }
        if (event.kind === "turn-end") {
            this.busy = false;
            this.clearWatchdog();
            this.onStatusChange?.();
            // A failed turn (fatal error just seen) must not auto-send whatever is
            // queued next — that would look like a normal continuation instead of
            // the failure it is. Leave the queue alone; the user chooses Retry or
            // explicitly promotes/steers the queued item (see dispatch()'s catch).
            if (!this.turnHadError) {
                const next = this.queue.shift();
                if (next) {
                    this.emitQueue();
                    void this.dispatch(next);
                }
            }
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
