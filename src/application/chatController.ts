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
import { transcriptText, transcriptMessages, transcriptMessagesUpTo } from "./controllerTranscript";
import {
    ChatQueue,
    MessageDedup,
    PendingMessage,
    type QueueDispatchOptions,
    SendMode,
} from "./controllerQueue";
import { ChangedFilesState } from "./changedFilesState";
import {
    HubState,
    HubStateContext,
    reloadGuardrails as reloadHubGuardrails,
    reloadTasks as reloadHubTasks,
    pendingTasksSummary as hubPendingTasksSummary,
} from "./controllerHubState";
import { OutboundPromptState } from "./outboundPrompt";
import { loadControllerHistory } from "./controllerHistory";
import { stableSessionKey } from "./sessionIdentity";
import type { ApplicationPorts } from "./ports";
import { routeControllerSend } from "./controllerSendRouter";
import { ControllerLiveState } from "./controllerLiveState";
import { ControllerClientActions } from "./controllerClientActions";
import { ControllerTurnRunner } from "./controllerTurnRunner";
import { ControllerRenderPersistence } from "./controllerRenderPersistence";
import type { RenderLogRecord } from "../renderLog";
import {
    applyPeerQueueCommand,
    createQueueSnapshot,
    reconcilePeerQueue,
} from "./controllerPeerQueue";

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
    // Persisted internal event stream; AHP owns client reconstruction.
    private readonly renderPersistence = new ControllerRenderPersistence(() => this.sessionId, {
        onExternalMessage: (message, record) => this.onExternalRenderMessage(message, record),
        onStatusChanged: () => this.onStatusChange?.(),
        onOwnershipAcquired: () => this.drainExternalQueueIfOwner(),
        log: (message) => this.onLog?.(message),
    });
    private readonly stream = this.renderPersistence.stream;
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
        dispatch: (message) => this.dispatchOwned(message),
        holdQueue: (hold) => this.queue.hold(hold),
        queuedCount: () => this.queue.length,
        releaseOwnership: () => this.renderPersistence.releaseOwnership(),
        log: (message) => this.onLog?.(message),
    });
    readonly client = new ControllerClientActions({
        queue: this.queue,
        getSession: () => this.session,
        turns: this.live.turns,
        statusChanged: () => this.onStatusChange?.(),
        onSend: (message, mode) => this.onSend(message, mode),
        emitQueue: () => this.emitQueue(),
        dispatch: (message) => this.dispatchOwned(message),
        canMutateQueue: () => this.renderPersistence.canDispatch(),
        emitPeerQueueCommand: (command) => this.stream.emit(command),
        log: (message) => this.onLog?.(message),
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
            releaseOwnership: () => this.renderPersistence.releaseOwnership(),
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
        return this.live.busy || this.renderPersistence.peerBusy;
    }

    get attentionStatus(): SessionTerminalStatus | undefined {
        if (this.isBusy) return undefined;
        return this.live.attentionStatus ?? this.renderPersistence.peerAttention;
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

    getSession(): AgentSession | undefined {
        return this.session;
    }

    subscribe(observer: (message: unknown) => void): () => void {
        return this.stream.addObserver(observer);
    }
    subscribeLive(observer: (message: unknown) => void): () => void {
        const detach = this.stream.addLiveObserver(observer);
        // The AHP projection attaches here, and it may be restoring a ChatState
        // persisted across a restart whose queue rows this controller has no
        // idea about. Live observers get no replay, so without an immediate
        // snapshot nothing ever contradicts those rows and they stay in the
        // Queued panel forever.
        observer(createQueueSnapshot(this.queue, this.live.busy));
        observer({ type: "changed-files", items: this.changedItemsRaw() });
        return detach;
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
    seedRenderLog(): boolean {
        const restored = this.renderPersistence.restore(this.options.resumeSessionId);
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

    async loadHistory(info: SessionInfo, transient = false): Promise<void> {
        this.historyInfo = info;
        this.historyCursor = undefined;
        this.historyCursor = await loadControllerHistory(this.adapter, info, (message) => {
            if (transient) this.stream.notify(message);
            else this.emit(message);
        });
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

    async pickAttachments(): Promise<Array<{ path: string; name: string }>> {
        return this.ports.files.pickFiles({
            many: true,
            label: "Attach",
            title: "Attach files to the message",
        });
    }

    private onSend(msg: PendingMessage, mode: SendMode): void {
        routeControllerSend(msg, mode, {
            queue: this.queue,
            dedup: this.dedup,
            // A live peer owner is a writable session, but not from this
            // controller. Route the message through the shared durable queue
            // instead of starting a second adapter resume.
            busy: () => this.live.busy || !this.renderPersistence.canDispatch(),
            cancel: () => this.session?.cancel(),
            dispatch: (message, options) => this.dispatchOwned(message, options),
            emitQueue: () => this.emitQueue(),
            log: (message) => this.onLog?.(message),
            getSession: () => this.session,
            turns: this.live.turns,
            createIntentId: () => this.ports.ids.create(),
            emit: (message) => this.emit(message),
        });
    }

    private emitQueue(): void {
        this.emit(createQueueSnapshot(this.queue, this.live.busy));
    }

    private dispatchOwned(message: PendingMessage, options: QueueDispatchOptions = {}): void {
        if (!this.renderPersistence.canDispatch()) {
            this.queue.unshift(message);
            this.emitQueue();
            this.onLog?.("[render-owner] dispatch deferred to the session owner");
            return;
        }
        void this.runner.dispatch(message, options);
    }

    private onExternalRenderMessage(message: unknown, record: RenderLogRecord): boolean | void {
        return reconcilePeerQueue(message, record, {
            queue: this.queue,
            isOwner: this.renderPersistence.isOwner,
            emitCanonical: () => this.emitQueue(),
            ingestNormalized: (normalized) => this.stream.ingestPersisted(normalized),
            snapshot: () => createQueueSnapshot(this.queue, this.live.busy),
            drain: () => this.drainExternalQueueIfOwner(),
            applyCommand: (command) => applyPeerQueueCommand(command, this.client, this.onLog),
        });
    }

    private drainExternalQueueIfOwner(): void {
        if (
            !this.renderPersistence.isOwner ||
            this.live.busy ||
            this.queue.isHeld ||
            this.queue.isEmpty
        ) {
            return;
        }
        const next = this.queue.shift();
        if (!next) return;
        this.emitQueue();
        this.onLog?.("[render-owner] dispatching a message queued by a peer controller");
        void this.runner.dispatch(next);
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
        this.stream.notify({ type: "changed-files", items: this.changedItemsRaw() });
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
        this.renderPersistence.dispose();
        this.queue.clear();
    }
}
