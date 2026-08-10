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
    persistEmit as persistEmitFn,
    seedRenderLog as seedRenderLogFn,
} from "./controllerPersist";
import { OutboundPromptState } from "./outboundPrompt";
import { loadControllerHistory } from "./controllerHistory";
import { stableSessionKey } from "./sessionIdentity";
import type { ApplicationPorts } from "./ports";
import { routeControllerSend } from "./controllerSendRouter";
import { ControllerLiveState } from "./controllerLiveState";
import { ControllerClientActions } from "./controllerClientActions";
import { ControllerTurnRunner } from "./controllerTurnRunner";

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

    private readonly persistState = { count: 0 };
    private readonly hubState: HubState = {
        guardrails: [],
        guardrailsLoaded: false,
        pendingTasks: [],
    };
    /** Prevents processing an accepted clientMessageId twice. */
    private readonly dedup = new MessageDedup();
    private readonly live = new ControllerLiveState({
        armWatchdog: () => this.runner.armWatchdog(),
        clearWatchdog: () => this.runner.clearWatchdog(),
        emit: (message) => this.emit(message),
        statusChanged: () => this.onStatusChange?.(),
        recordChanged: (file, added, removed) => {
            this.changed.record(file, added, removed);
            this.emitChanged();
        },
        takeQueued: () => (this.queue.isHeld ? undefined : this.queue.shift()),
        emitQueue: () => this.emitQueue(),
        dispatch: (message) => {
            void this.runner.dispatch(message);
        },
        holdQueue: (hold) => this.queue.hold(hold),
        queuedCount: () => this.queue.length,
        log: (message) => this.onLog?.(message),
    });
    readonly client = new ControllerClientActions({
        queue: this.queue,
        getSession: () => this.session,
        turns: this.live.turns,
        statusChanged: () => this.onStatusChange?.(),
        onSend: (message, mode) => this.onSend(message, mode),
        emitQueue: () => this.emitQueue(),
        dispatch: (message) => void this.runner.dispatch(message),
    });
    private readonly runner: ControllerTurnRunner;

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        private readonly ports: ApplicationPorts,
        private readonly onStatusChange?: () => void,
        private readonly onLog?: (message: string) => void,
    ) {
        this.runner = new ControllerTurnRunner({
            adapter,
            options,
            ports,
            hub: this.hub,
            hubState: this.hubState,
            promptState: this.promptState,
            live: this.live,
            queue: this.queue,
            sessionId: () => this.sessionId,
            getSession: () => this.session,
            setSession: (session) => {
                this.session = session;
            },
            reloadGuardrails: () => this.reloadGuardrails(),
            reloadTasks: () => this.reloadTasks(),
            checkpointId: () => this.injectedCheckpointId,
            setCheckpointId: (id) => {
                this.injectedCheckpointId = id;
            },
            aiToolsInfo: () => this.aiToolsInfo(),
            pendingTasksSummary: () => this.pendingTasksSummary(),
            emit: (message) => this.emit(message),
            emitQueue: () => this.emitQueue(),
            statusChanged: () => this.onStatusChange?.(),
            log: (message) => this.onLog?.(message),
        });
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

    get lastTurnId(): string | undefined {
        return this.live.lastLogicalTurnId;
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
        if (this.live.busy && !this.runner.watching) {
            this.runner.armWatchdog();
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
        // Whether a restored queue was "waiting for a turn" or "held after a
        // failure" isn't durably recorded (the flag is in-memory only). A
        // non-empty queue surviving a full reload/restart is always some kind
        // of interrupted state, so treat it as held rather than assume it's
        // safe to silently auto-fire — the next explicit send/promote/retry
        // releases it either way.
        if (restored.pending.length > 0) {
            this.queue.hold();
        }
        return restored.seeded;
    }

    private historyInfo?: SessionInfo;
    private historyCursor?: string;

    async loadHistory(info: SessionInfo): Promise<void> {
        this.historyInfo = info;
        this.historyCursor = undefined;
        this.historyCursor = await loadControllerHistory(this.adapter, info, (message) =>
            this.emit(message),
        );
    }

    /**
     * Loads the next older page of history (scroll-up pagination). No-op when
     * there is no cursor (transcript fully loaded or no history loaded yet).
     */
    async loadMoreHistory(): Promise<void> {
        if (!this.historyInfo || !this.historyCursor) return;
        const cursor = this.historyCursor;
        this.historyCursor = await loadControllerHistory(
            this.adapter,
            this.historyInfo,
            (message) => this.emit(message),
            cursor,
        );
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
                    void this.runner.dispatch(queued);
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
            dispatch: (message) => void this.runner.dispatch(message),
            emitQueue: () => this.emitQueue(),
            log: (message) => this.onLog?.(message),
        });
    }

    private emitQueue(): void {
        this.emit({
            type: "queue",
            items: this.queue.items(),
            held: this.queue.isHeld,
            busy: this.live.busy,
        });
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
        this.runner.clearWatchdog();
        this.session?.dispose();
        this.session = undefined;
        this.queue.clear();
    }
}
