import { AgentAdapter, AgentEvent, AgentSession, SessionInfo, SessionStartOptions } from "../adapters/types";
import { parseTodoFence } from "../adapters/todos";
import { buildOutboundPrompt } from "./outboundPrompt";
import { probeRtk, rtkCached } from "../adapters/rtk";
import { HubClient } from "../sync/hubClient";
import { fetchLatestCheckpoint } from "../sync/tasks";
import { fetchSessionGuardrails } from "../sync/guardrails";
import { WebviewToHost } from "./protocol";
import { RenderStream } from "./renderStream";
import { transcriptText, transcriptMessages, transcriptMessagesUpTo, transcriptUpTo } from "./controllerTranscript";
import { ChatQueue, PendingMessage, SendMode } from "./controllerQueue";
import { ChangedFilesState } from "./changedFilesState";
import { handleControllerMessage } from "./controllerMessageHandler";

/** Owns one live dialogue process; view switches only detach/replay the stream. */
export class ChatController {
    private session: AgentSession | undefined;
    private busy = false;
    private firstTitle = "";
    private outboundPolicyInjected = false;
    private todoInjected = false;
    private autonomyInjected = false;
    private seedInjected = false;
    private rtkInjected = false;
    private sessionIdInjected = false;
    private bootstrapInjected = false;
    private checkpointInjected = false;
    private readonly hub = new HubClient();
    // Id of the session checkpoint already injected as resume context, so the
    // same one isn't re-prepended every continuity turn.
    private injectedCheckpointId: string | undefined;
    // User-defined guardrails, cached and injected on every message. Reloaded
    // lazily and whenever the user edits them in the UI.
    private guardrails: string[] = [];
    private guardrailsLoaded = false;
    private readonly changed = new ChangedFilesState();
    private readonly queue = new ChatQueue();
    // Replayable render-message buffer + webview sink + read-only followers.
    private readonly stream = new RenderStream();
    // Watchdog: force-ends a turn that goes silent (no events) for too long, so a
    // stalled tool call or dropped backend connection can't pin the session as
    // "working" forever (it survives reloads since the controller outlives them).
    // Reset by every event, so long but active tools/streams are unaffected.
    private watchdog: ReturnType<typeof setTimeout> | undefined;
    private static readonly TURN_SILENCE_MS = 5 * 60 * 1000;

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
        if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = undefined; }
        if (!this.busy) { return; }
        this.watchdog = setTimeout(() => this.forceEndStalledTurn(), ChatController.TURN_SILENCE_MS);
    }

    private clearWatchdog(): void {
        if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = undefined; }
    }

    /** Recovers a turn that produced no events for TURN_SILENCE_MS. */
    private forceEndStalledTurn(): void {
        if (!this.busy) { return; }
        this.busy = false;
        this.clearWatchdog();
        this.session?.cancel();
        this.onStatusChange?.();
        this.emit({ type: "event", event: { kind: "error", message: "Turn ended automatically: no activity from the agent for 5 minutes (likely a stalled tool or dropped connection)." } });
        this.emit({ type: "event", event: { kind: "turn-end" } });
        const next = this.queue.shift();
        if (next) { this.emitQueue(); void this.dispatch(next); }
    }

    get backend(): string { return this.adapter.backend; }
    get cwd(): string { return this.options.cwd; }
    /** Parent session id when this controller drives a spawned subagent. */
    get parentId(): string | undefined { return this.options.parentId; }
    /** First user message, used as a title for a not-yet-persisted live session. */
    get title(): string { return this.firstTitle || "New session"; }

    /** Plain-text user/assistant exchange, for backend handoff. */
    transcript(): string {
        return transcriptText(this.stream.messages);
    }

    /** Renderable user/assistant rows, for repainting prior exchange. */
    transcriptMessages(): { role: "user" | "assistant"; text: string }[] {
        return transcriptMessages(this.stream.messages);
    }

    /** Visible user/assistant rows up to and including `index` (0-based). */
    transcriptMessagesUpTo(index: number): { role: "user" | "assistant"; text: string }[] {
        return transcriptMessagesUpTo(this.stream.messages, index);
    }

    /** Plain-text transcript up to and including `index` (0-based). */
    transcriptUpTo(index: number): string {
        return transcriptUpTo(this.stream.messages, index);
    }

    get attached(): boolean {
        return this.stream.hasSink;
    }

    /** Binds this controller to a webview sink and replays its render log. */
    attach(sink: (message: unknown) => void): void {
        // A controller that was already busy before this attach (e.g. survived a
        // reload) may have no watchdog armed — re-arm so a stalled turn still
        // self-heals instead of showing "working" forever.
        if (this.busy && !this.watchdog) { this.armWatchdog(); }
        this.stream.bindSink(sink);   // sets the sink + replays the buffered log
        // The edited-files set is controller state (not in the replay log), so
        // push it after replay — this is what keeps approvals from "coming back"
        // when switching away and back.
        this.emitChanged();
    }

    /** Stops forwarding to the webview but keeps the process running. */
    detach(): void {
        this.stream.clearSink();
    }

    /**
     * Subscribes a read-only follower to the render stream and replays the log
     * so a late joiner (remote viewer) sees the full conversation. Returns an
     * unsubscribe function. Does not affect the active webview sink.
     */
    subscribe(observer: (message: unknown) => void): () => void {
        return this.stream.addObserver(observer);
    }

    private emit(message: unknown): void {
        this.stream.emit(message);
    }

    /** Sends a message to this session programmatically (public API / bridge). */
    sendText(text: string, mode: SendMode = "send"): void {
        this.onSend({ text, attachments: [] }, mode);
    }

    /** Interrupts the running turn, if any (public API / bridge). */
    interrupt(): void {
        this.session?.cancel();
    }

    /** Per-session tool gating (native AI backend only; undefined elsewhere). */
    aiToolsInfo(): { available: string[]; enabled: string[] } | undefined {
        return this.session?.aiTools?.();
    }

    setAiTools(names: string[]): void {
        this.session?.setAiTools?.(names);
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
        this.guardrailsLoaded = true;
        if (!this.sessionId || !this.hub.configured()) { this.guardrails = []; return; }
        try { this.guardrails = (await fetchSessionGuardrails(this.hub, this.sessionId)).map((g) => g.text).filter(Boolean); }
        catch { /* keep the prior cache */ }
    }

    private async dispatch(msg: PendingMessage): Promise<void> {
        // Guardrails: load once (cached), then inject on every message below.
        if (!this.guardrailsLoaded && this.adapter.roleAware?.() === true && this.sessionId && this.hub.configured()) {
            await this.reloadGuardrails();
        }
        // Resume hook (deterministic, no LLM): on a CONTINUITY message — the agent
        // was idle or queued, NOT steered — prepend this session's latest
        // checkpoint so it resumes from its own anchor without having to search.
        // Looked up by session id; de-duped so the same checkpoint isn't repeated.
        if (msg.mode !== "steer" && this.adapter.roleAware?.() === true && this.sessionId && this.hub.configured()) {
            try {
                const cp = await fetchLatestCheckpoint(this.hub, this.sessionId);
                if (cp && cp.id !== this.injectedCheckpointId) {
                    msg.resumeCheckpoint = `[Resume — latest checkpoint for this session]\n${cp.title}\n${cp.summary}`;
                    this.injectedCheckpointId = cp.id;
                }
            } catch { /* best-effort; resume still proceeds without it */ }
        }
        // Apply per-message model/reasoning to the live options BEFORE (re)starting
        // or sending. Stateless backends (OpenAI HTTP) read options.model on each
        // request, so this lets the user switch model between messages. A running
        // CLI process keeps its spawn-time model (it's pinned there).
        if (msg.model && msg.model !== "default" && msg.model !== "auto") {
            this.options.model = msg.model;
        }
        if (msg.reasoning && msg.reasoning !== "default") {
            this.options.reasoning = msg.reasoning;
        }
        if (msg.permission) {
            this.options.permission = msg.permission;
        }
        if (msg.execDisplay) {
            this.options.execDisplay = msg.execDisplay;
        }
        // Presence drives unbounded tool loops for API backends (autonomous mode).
        this.options.autonomy = msg.autonomy;
        if (!this.session) {
            this.session = this.adapter.start(this.options);
            this.session.on("event", (event: AgentEvent) => this.onEvent(event));
        }
        // Images are inlined as vision blocks when the backend supports it
        // (more reliable than asking the agent to Read them from disk).
        const isImage = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);
        const canVision = this.adapter.supportsImages?.() === true;
        const images = canVision ? msg.attachments.filter(isImage) : [];
        const fileAtts = canVision ? msg.attachments.filter((p) => !isImage(p)) : msg.attachments;
        // Role-aware backends (HTTP API) carry one-shot app instructions as
        // `developer` messages; CLIs get them prepended to the user text.
        const roleAware = this.adapter.roleAware?.() === true;
        const outbound = buildOutboundPrompt({
            text: msg.text,
            fileAttachments: fileAtts,
            policyInjected: this.outboundPolicyInjected,
            todoInjected: this.todoInjected,
            seedInjected: this.seedInjected,
            autonomyInjected: this.autonomyInjected,
            rtkInjected: this.rtkInjected,
            sessionIdInjected: this.sessionIdInjected,
            bootstrapInjected: this.bootstrapInjected,
            checkpointInjected: this.checkpointInjected,
            sessionId: this.sessionId,
            rtk: rtkCached(),
            // Checkpoint discipline only where it's needed: a context-windowing
            // backend (roleAware/native) that has the Sufficit memory tool.
            checkpoints: roleAware && ((this.aiToolsInfo()?.available) ?? []).includes("memory_save"),
            todoInjection: this.adapter.hasNativeTodo?.() === false ? this.adapter.todoInjection?.() : undefined,
            seedHistory: this.options.seedHistory,
            bootstrap: this.options.bootstrap,
            resumeCheckpoint: msg.resumeCheckpoint,
            guardrails: this.guardrails,
            autonomy: msg.autonomy,
            asRoles: roleAware,
        });
        this.outboundPolicyInjected = outbound.state.policyInjected;
        this.todoInjected = outbound.state.todoInjected;
        this.seedInjected = outbound.state.seedInjected;
        this.bootstrapInjected = !!outbound.state.bootstrapInjected;
        this.checkpointInjected = !!outbound.state.checkpointInjected;
        this.autonomyInjected = outbound.state.autonomyInjected;
        this.rtkInjected = !!outbound.state.rtkInjected;
        this.sessionIdInjected = !!outbound.state.sessionIdInjected;
        if (!this.firstTitle && msg.text.trim()) { this.firstTitle = msg.text.trim().slice(0, 60); }
        this.busy = true;
        this.armWatchdog();
        this.onStatusChange?.();
        this.emit({ type: "user", text: msg.text, attachments: msg.attachments });
        try {
            this.session.send(outbound.text, images, outbound.preamble);
        } catch (error) {
            // A synchronous adapter failure (for example transcript persistence or
            // process spawn setup) must never leave the controller permanently
            // busy. Surface the error and continue draining queued messages.
            this.busy = false;
            this.clearWatchdog();
            this.onStatusChange?.();
            this.emit({ type: "event", event: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
            const next = this.queue.shift();
            if (next) {
                this.emitQueue();
                void this.dispatch(next);
            }
        }
    }

    private onEvent(event: AgentEvent): void {
        // Any backend activity proves the turn is alive — push the watchdog out.
        if (this.busy) { this.armWatchdog(); }
        this.emit({ type: "event", event });
        // Track edited files here (authoritative, survives view switches).
        if (event.kind === "tool-start" && event.path && (event.added != null || event.removed != null)) {
            this.changed.record(event.path, event.added, event.removed);
            this.emitChanged();
        }
        // For CLIs with no native todo tool, recognize a fenced ```todo block in
        // the agent's text and surface it as a plan update.
        if (event.kind === "text" && this.adapter.hasNativeTodo?.() === false) {
            const todos = parseTodoFence(event.text);
            if (todos) {
                this.emit({ type: "event", event: { kind: "tool-start", toolName: "TodoWrite", detail: "", todos } });
            }
        }
        if (event.kind === "turn-end") {
            this.busy = false;
            this.clearWatchdog();
            this.onStatusChange?.();
            const next = this.queue.shift();
            if (next) {
                this.emitQueue();
                void this.dispatch(next);
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
