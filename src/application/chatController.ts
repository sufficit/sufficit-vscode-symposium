import {
    AgentAdapter,
    AgentSession,
    SessionInfo,
    SessionStartOptions,
    TodoItem,
    type SessionTerminalStatus,
} from "../adapters/types";
import { todosSummary } from "../adapters/todos";
import { type TrackingMode } from "./outboundPrompt";
import { probeRtk } from "../adapters/rtk";
import { HubClient } from "../sync/hubClient";
import { WebviewToHost } from "../protocol/chat";
import { RenderStream } from "./renderStream";
import { transcriptText, transcriptMessages, transcriptMessagesUpTo } from "./controllerTranscript";
import { ChatQueue, MessageDedup, PendingMessage, SendMode } from "./controllerQueue";
import { ChangedFilesState } from "./changedFilesState";
import { ControllerRenderPersistence } from "./controllerRenderPersistence";
import { handleControllerMessage } from "./controllerMessageHandler";
import {
    HubState,
    HubStateContext,
    reloadGuardrails as reloadHubGuardrails,
    reloadTasks as reloadHubTasks,
    pendingTasksSummary as hubPendingTasksSummary,
} from "./controllerHubState";
import {
    WatchdogContext,
    armWatchdog as armWatchdogFn,
    clearWatchdog as clearWatchdogFn,
} from "./controllerWatchdog";
import { OutboundPromptState } from "./outboundPrompt";
import { ControllerEventHandler } from "./controllerEventHandler";
import { loadControllerHistory } from "./controllerHistory";
import { stableSessionKey } from "./sessionIdentity";
import type { ApplicationPorts } from "./ports";
import { routeControllerSend } from "./controllerSendRouter";
import { dispatchControllerMessage } from "./controllerDispatch";

export class ChatController {
    private session: AgentSession | undefined;
    private busy = false;
    // Fatal turns do not auto-drain queued work; the user chooses how to recover.
    public attentionStatus: SessionTerminalStatus | undefined;
    private firstTitle = "";
    // One-shot outbound-prompt injection flags.
    private readonly promptState: OutboundPromptState = {
        policyInjected: false,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        rtkInjected: false,
        sessionIdInjected: false,
        bootstrapInjected: false,
        checkpointInjected: false,
        trackingInjected: false,
    };
    // Latest native/fence TodoWrite state, used when Hub tasks are unavailable.
    private lastTodos: TodoItem[] = [];
    private trackingMode: TrackingMode | undefined;
    private readonly hub = new HubClient();
    // Checkpoint already injected as resume context.
    private injectedCheckpointId: string | undefined;

    private readonly changed = new ChangedFilesState();
    private readonly queue = new ChatQueue();
    // Replayable and persisted render stream.
    private readonly renderPersistence = new ControllerRenderPersistence(() => this.sessionId);
    private readonly stream: RenderStream = this.renderPersistence.stream;
    // Force-ends a silent turn that would otherwise stay working forever.
    private readonly watchdogState = {
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };

    private readonly hubState: HubState = {
        guardrails: [],
        guardrailsLoaded: false,
        pendingTasks: [],
    };
    /** Prevents processing an accepted clientMessageId twice. */
    private readonly dedup = new MessageDedup();
    /** Stable logical turn reused by Retry. */
    private lastLogicalTurnId: string | undefined;
    private readonly eventHandler = new ControllerEventHandler({
        isBusy: () => this.busy,
        setBusy: (busy) => {
            this.busy = busy;
        },
        armWatchdog: () => this.armWatchdog(),
        clearWatchdog: () => this.clearWatchdog(),
        emit: (message) => this.emit(message),
        statusChanged: () => this.onStatusChange?.(),
        recordChanged: (file, added, removed) => {
            this.changed.record(file, added, removed);
            this.emitChanged();
        },
        setTodos: (todos) => {
            this.lastTodos = todos;
        },
        trackingMode: () => this.trackingMode,
        markTurnFailed: () => {
            this.attentionStatus = "error";
        },
        markTurnWarning: () => {
            this.attentionStatus = "warning";
        },
        turnFailed: () => this.attentionStatus === "error",
        setLogicalTurnId: (id) => {
            this.lastLogicalTurnId = id;
        },
        takeQueued: () => this.queue.shift(),
        emitQueue: () => this.emitQueue(),
        dispatch: (message) => {
            void this.dispatch(message);
        },
    });

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        private readonly ports: ApplicationPorts,
        private readonly onStatusChange?: () => void,
    ) {
        void probeRtk(options.cwd);
    }

    get sessionId(): string | undefined {
        return this.session?.sessionId ?? this.options.resumeSessionId;
    }

    get sessionKey(): string | undefined {
        return stableSessionKey(this.options.resumeSessionId, this.session?.sessionId);
    }

    get isBusy(): boolean {
        return this.busy;
    }

    get lastTurnId(): string | undefined {
        return this.lastLogicalTurnId;
    }

    private armWatchdog(): void {
        armWatchdogFn(this.watchdogContext(), this.watchdogState);
    }

    private clearWatchdog(): void {
        clearWatchdogFn(this.watchdogState);
    }

    private watchdogContext(): WatchdogContext {
        return {
            busy: () => this.busy,
            setBusy: (v) => {
                this.busy = v;
            },
            markTurnFailed: () => {
                this.attentionStatus = "error";
            },
            cancel: () => this.session?.cancel(),
            onStatusChange: () => this.onStatusChange?.(),
            emit: (m) => this.emit(m),
            silenceMinutes: () =>
                this.ports.configuration.get("symposium", "turnSilenceMinutes", 5),
        };
    }

    private hubContext(): HubStateContext {
        return { sessionId: () => this.sessionId, hub: () => this.hub, state: this.hubState };
    }

    get backend(): string {
        return this.adapter.backend;
    }
    get cwd(): string {
        return this.options.cwd;
    }
    get parentId(): string | undefined {
        return this.options.parentId;
    }
    get lineageId(): string | undefined {
        return this.options.lineageId;
    }
    get title(): string {
        return this.firstTitle || "New session";
    }

    setModel(model: string): void {
        this.options.model = model === "default" ? undefined : model;
        this.session?.setModel?.(model);
    }
    getModel(): string {
        return this.session?.getModel?.() || this.options.model || "";
    }

    transcript(): string {
        return transcriptText(this.stream.messages);
    }
    transcriptMessages(): { role: "user" | "assistant"; text: string }[] {
        return transcriptMessages(this.stream.messages);
    }
    transcriptMessagesUpTo(index: number): { role: "user" | "assistant"; text: string }[] {
        return transcriptMessagesUpTo(this.stream.messages, index);
    }
    transcriptUpTo(index: number): string {
        const rows = transcriptMessagesUpTo(this.stream.messages, index);
        return rows
            .map((r) => `${r.role === "user" ? "user" : "assistant"}: ${r.text}`)
            .join("\n\n");
    }

    get attached(): boolean {
        return this.stream.hasSink;
    }
    getSession(): AgentSession | undefined {
        return this.session;
    }

    /** Binds this controller to one webview sink and replays its render log. */
    attach(sink: (message: unknown) => void): () => void {
        // A reattached busy controller may need its watchdog rearmed.
        if (this.busy && !this.watchdogState.timer) {
            this.armWatchdog();
        }
        const detach = this.stream.bindSink(sink);
        // Edited-file approval state is separate from the replay log.
        this.emitChanged();
        return detach;
    }

    subscribe(observer: (message: unknown) => void): () => void {
        return this.stream.addObserver(observer);
    }
    private emit(message: unknown): void {
        this.stream.emit(message);
    }

    sendText(text: string, mode: SendMode = "send"): void {
        this.onSend({ text, attachments: [] }, mode);
    }

    interrupt(): void {
        this.session?.cancel();
    }
    continueTurn(): void {
        const session = this.session;
        if (this.busy || !session?.continueTurn) return;
        this.busy = true;
        this.attentionStatus = undefined;
        this.onStatusChange?.();
        session.continueTurn();
    }

    aiToolsInfo(): { available: string[]; enabled: string[] } | undefined {
        return this.session?.aiTools?.();
    }

    setAiTools(names: string[]): void {
        this.session?.setAiTools?.(names);
    }
    seedRenderLog(): boolean {
        const restored = this.renderPersistence.restore(this.options.resumeSessionId);
        this.queue.restore(restored.pending);
        return restored.seeded;
    }

    async loadHistory(info: SessionInfo): Promise<void> {
        await loadControllerHistory(this.adapter, info, (message) => this.emit(message));
    }

    async handleMessage(message: WebviewToHost): Promise<boolean> {
        return handleControllerMessage(
            message,
            {
                busy: () => this.busy,
                cancel: () => this.session?.cancel(),
                continueTurn: () => this.continueTurn(),
                queue: this.queue,
                stream: this.stream,
                emitQueue: () => this.emitQueue(),
                dispatch: (queued) => {
                    void this.dispatch(queued);
                },
                onSend: (pending, mode) => this.onSend(pending, mode),
                resolveApproval: (toolId, approved) =>
                    this.session?.resolveApproval?.(toolId, approved),
            },
            this.ports.files,
        );
    }

    private onSend(msg: PendingMessage, mode: SendMode): void {
        routeControllerSend(msg, mode, {
            queue: this.queue,
            dedup: this.dedup,
            busy: () => this.busy,
            cancel: () => this.session?.cancel(),
            dispatch: (message) => void this.dispatch(message),
            emitQueue: () => this.emitQueue(),
        });
    }

    private emitQueue(): void {
        this.emit({ type: "queue", items: this.queue.items() });
    }

    async reloadGuardrails(): Promise<void> {
        await reloadHubGuardrails(this.hubContext());
    }

    private async reloadTasks(): Promise<void> {
        await reloadHubTasks(this.hubContext());
    }

    /** Prefers Hub task reminders, then falls back to native/fence todos. */
    private pendingTasksSummary(): string | undefined {
        return hubPendingTasksSummary(this.hubContext()) ?? todosSummary(this.lastTodos);
    }

    private dispatch(message: PendingMessage): Promise<void> {
        // This controller is taking write ownership of the resumed session.
        this.renderPersistence.stop();
        this.attentionStatus = undefined;
        return dispatchControllerMessage(message, {
            adapter: this.adapter,
            options: this.options,
            ports: this.ports,
            hub: this.hub,
            hubState: this.hubState,
            promptState: this.promptState,
            sessionId: () => this.sessionId,
            getSession: () => this.session,
            setSession: (session) => {
                this.session = session;
            },
            onSessionEvent: this.eventHandler.handle,
            reloadGuardrails: () => this.reloadGuardrails(),
            reloadTasks: () => this.reloadTasks(),
            checkpointId: () => this.injectedCheckpointId,
            setCheckpointId: (id) => {
                this.injectedCheckpointId = id;
            },
            aiToolsInfo: () => this.aiToolsInfo(),
            pendingTasksSummary: () => this.pendingTasksSummary(),
            setTrackingMode: (mode) => {
                this.trackingMode = mode;
            },
            hasFirstTitle: () => !!this.firstTitle,
            setFirstTitle: (title) => {
                this.firstTitle = title;
            },
            armWatchdog: () => this.armWatchdog(),
            clearWatchdog: () => this.clearWatchdog(),
            setBusy: (busy) => {
                this.busy = busy;
            },
            setAttentionError: () => {
                this.attentionStatus = "error";
            },
            statusChanged: () => this.onStatusChange?.(),
            emit: (outbound) => this.emit(outbound),
        });
    }

    private emitChanged(): void {
        this.stream.toSink({ type: "changed-files", items: this.changedItemsRaw() });
    }

    changedPaths(): string[] {
        return this.changed.paths();
    }

    changedItemsRaw(): { path: string; added: number; removed: number }[] {
        return this.changed.items();
    }

    resolveChanged(path: string): void {
        if (this.changed.resolve(path)) {
            this.emitChanged();
        }
    }

    dispose(): void {
        this.renderPersistence.stop();
        this.clearWatchdog();
        this.session?.dispose();
        this.session = undefined;
        this.queue.clear();
    }
}
