import {
    AgentAdapter,
    AgentSession,
    SessionInfo,
    SessionStartOptions,
    type SessionTerminalStatus,
} from "../adapters/types";
import { todosSummary } from "../adapters/todos";
import { probeRtk } from "../adapters/rtk";
import { HubClient } from "../sync/hubClient";
import { WebviewToHost } from "../protocol/chat";
import { RenderStream } from "./renderStream";
import { transcriptText, transcriptMessages, transcriptMessagesUpTo } from "./controllerTranscript";
import { ChatQueue, MessageDedup, PendingMessage, SendMode } from "./controllerQueue";
import { ChangedFilesState } from "./changedFilesState";
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
import {
    persistEmit as persistEmitFn,
    seedRenderLog as seedRenderLogFn,
} from "./controllerPersist";
import { OutboundPromptState } from "./outboundPrompt";
import { loadControllerHistory } from "./controllerHistory";
import { stableSessionKey } from "./sessionIdentity";
import type { ApplicationPorts } from "./ports";
import { routeControllerSend } from "./controllerSendRouter";
import { dispatchControllerMessage } from "./controllerDispatch";
import { ControllerLiveState } from "./controllerLiveState";
import { ControllerClientActions } from "./controllerClientActions";

export class ChatController {
    private runtimeKey: string | undefined;
    private session: AgentSession | undefined;
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
    private readonly hub = new HubClient();
    // Checkpoint already injected as resume context.
    private injectedCheckpointId: string | undefined;

    private readonly changed = new ChangedFilesState();
    private readonly queue = new ChatQueue();
    // Replayable and persisted render stream.
    private readonly stream = new RenderStream((m) => this.persistEmit(m));
    // Force-ends a silent turn that would otherwise stay working forever.
    private readonly watchdogState = {
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };

    private readonly persistState = { count: 0 };
    private readonly hubState: HubState = {
        guardrails: [],
        guardrailsLoaded: false,
        pendingTasks: [],
    };
    /** Prevents processing an accepted clientMessageId twice. */
    private readonly dedup = new MessageDedup();
    private readonly live = new ControllerLiveState({
        armWatchdog: () => this.armWatchdog(),
        clearWatchdog: () => this.clearWatchdog(),
        emit: (message) => this.emit(message),
        statusChanged: () => this.onStatusChange?.(),
        recordChanged: (file, added, removed) => {
            this.changed.record(file, added, removed);
            this.emitChanged();
        },
        takeQueued: () => this.queue.shift(),
        emitQueue: () => this.emitQueue(),
        dispatch: (message) => {
            void this.dispatch(message);
        },
    });
    readonly client = new ControllerClientActions({
        queue: this.queue,
        getSession: () => this.session,
        isBusy: () => this.live.busy,
        setBusy: (busy) => {
            this.live.busy = busy;
        },
        clearAttention: () => {
            this.live.attentionStatus = undefined;
        },
        statusChanged: () => this.onStatusChange?.(),
        onSend: (message, mode) => this.onSend(message, mode),
        emitQueue: () => this.emitQueue(),
        dispatch: (message) => void this.dispatch(message),
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
        return stableSessionKey(
            this.options.resumeSessionId,
            this.session?.sessionId,
            this.runtimeKey,
        );
    }

    setRuntimeKey(key: string): void {
        this.runtimeKey = key;
    }

    get isBusy(): boolean {
        return this.live.busy;
    }

    get attentionStatus(): SessionTerminalStatus | undefined {
        return this.live.attentionStatus;
    }

    set attentionStatus(value: SessionTerminalStatus | undefined) {
        this.live.attentionStatus = value;
    }

    get lastTurnId(): string | undefined {
        return this.live.lastLogicalTurnId;
    }

    private armWatchdog(): void {
        armWatchdogFn(this.watchdogContext(), this.watchdogState);
    }

    private clearWatchdog(): void {
        clearWatchdogFn(this.watchdogState);
    }

    private watchdogContext(): WatchdogContext {
        return {
            busy: () => this.live.busy,
            setBusy: (v) => {
                this.live.busy = v;
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
        return this.live.firstTitle || "New session";
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
        if (this.live.busy && !this.watchdogState.timer) {
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
    subscribeLive(observer: (message: unknown) => void): () => void {
        return this.stream.addLiveObserver(observer);
    }
    private emit(message: unknown): void {
        this.stream.emit(message);
    }

    aiToolsInfo(): { available: string[]; enabled: string[] } | undefined {
        return this.session?.aiTools?.();
    }

    setAiTools(names: string[]): void {
        this.session?.setAiTools?.(names);
    }
    private persistEmit(message: unknown): void {
        persistEmitFn(
            { sessionId: () => this.sessionId, stream: this.stream, state: this.persistState },
            message,
        );
    }

    seedRenderLog(): boolean {
        const restored = seedRenderLogFn(
            { sessionId: () => this.sessionId, stream: this.stream, state: this.persistState },
            this.options.resumeSessionId,
        );
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
                busy: () => this.live.busy,
                cancel: () => this.session?.cancel(),
                continueTurn: () => void this.client.continueTurn(),
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
            busy: () => this.live.busy,
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
        return hubPendingTasksSummary(this.hubContext()) ?? todosSummary(this.live.todos);
    }

    private dispatch(message: PendingMessage): Promise<void> {
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
            onSessionEvent: this.live.eventHandler.handle,
            reloadGuardrails: () => this.reloadGuardrails(),
            reloadTasks: () => this.reloadTasks(),
            checkpointId: () => this.injectedCheckpointId,
            setCheckpointId: (id) => {
                this.injectedCheckpointId = id;
            },
            aiToolsInfo: () => this.aiToolsInfo(),
            pendingTasksSummary: () => this.pendingTasksSummary(),
            setTrackingMode: (mode) => {
                this.live.trackingMode = mode;
            },
            hasFirstTitle: () => !!this.live.firstTitle,
            setFirstTitle: (title) => {
                this.live.firstTitle = title;
            },
            armWatchdog: () => this.armWatchdog(),
            clearWatchdog: () => this.clearWatchdog(),
            setBusy: (busy) => {
                this.live.busy = busy;
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
        this.clearWatchdog();
        this.session?.dispose();
        this.session = undefined;
        this.queue.clear();
    }
}
