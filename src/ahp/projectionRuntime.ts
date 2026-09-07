import type { AgentEvent, HistoryMessage } from "../adapters/types";
import type { PendingMessage } from "../application/controllerQueue";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { AhpHostRuntime, type AhpRuntimeExport, type AhpSessionHandle } from "./hostRuntime";
import { historyTurns, mergeExpectedTurns, turnText } from "./historyProjection";
import { AhpPersistence } from "./persistence";
import {
    asRecord,
    isAgentEvent,
    optionalString,
    optionalTimestamp,
    positive,
    redact,
    sessionKey,
    stringArray,
} from "./projectionRuntimeValues";
import {
    createProjectionState,
    projectAgentEvent,
    projectInjectedUser,
    rememberProjectedUser,
    type AhpProjectionAction,
    type AhpProjectionState,
} from "./projectAgentEvent";
import {
    createQueueProjectionState,
    projectQueue,
    projectionDiagnostics,
    seedQueueProjection,
    sessionChatSummaryChanges,
    type QueueProjectionState,
} from "./projectControllerState";
export interface AhpProjectionSessionInfo {
    backend: string;
    sessionId: string;
    title: string;
    cwd: string;
}
export interface AhpProjectionSource {
    list(): AhpProjectionSessionInfo[];
    follow(id: string, observer: (message: unknown) => void): (() => void) | undefined;
}

export interface AhpProjectionDiagnostic {
    category: "transcript" | "status" | "queue" | "approval" | "projection";
    session: string;
    sequence: number;
    detail: string;
}

export interface AhpProjectionOptions {
    restored?: AhpRuntimeExport;
    persistence?: AhpPersistence;
    replayCapacity?: number;
    maxDiagnostics?: number;
    /** Reports a mismatch immediately; the periodic dump buries and truncates it. */
    onDiagnostic?: (message: string) => void;
}

interface ProjectionRecord {
    handle: AhpSessionHandle;
    unsubscribe: () => void;
    projection: AhpProjectionState;
    queue: QueueProjectionState;
    expectedTurns: string[];
    currentText?: string;
    queueLength: number;
    approvals: Set<string>;
}

export class AhpProjectionRuntime {
    readonly runtime: AhpHostRuntime;
    private readonly records = new Map<string, ProjectionRecord>();
    private readonly recent: AhpProjectionDiagnostic[] = [];
    private readonly counts = new Map<AhpProjectionDiagnostic["category"], number>();
    private readonly maximumDiagnostics: number;

    constructor(
        private readonly source: AhpProjectionSource,
        private readonly options: AhpProjectionOptions = {},
    ) {
        this.runtime = new AhpHostRuntime({
            restored: options.restored,
            replayCapacity: options.replayCapacity,
        });
        this.maximumDiagnostics = positive(options.maxDiagnostics, 100);
    }

    sync(): void {
        const current = new Set<string>();
        const listed = this.source.list();
        for (const info of listed) {
            const key = sessionKey(info.backend, info.sessionId);
            current.add(key);
            if (!this.records.has(key)) this.attach(key, info);
        }
        for (const [key, record] of this.records) {
            if (current.has(key)) continue;
            record.unsubscribe();
            this.runtime.disposeSession(record.handle.sessionResource);
            this.records.delete(key);
        }
        this.options.persistence?.maybeSave(this.runtime);
    }

    /**
     * Re-attaches the projection observer for a controller whose persisted render
     * log was seeded. Preserves any turns already loaded into the AHP runtime
     * (e.g. from a prior lazy-loading pass) so reopening a session does not
     * discard the scroll-up history the user already waited for.
     */
    rebuild(provider: string, nativeSessionId: string): void {
        const key = sessionKey(provider, nativeSessionId);
        const current = this.records.get(key);
        if (current) {
            // Keep the AHP channel and its loaded turns; only re-subscribe the
            // live observer so new events flow into the existing projection.
            current.unsubscribe();
            const info = this.source
                .list()
                .find((item) => item.backend === provider && item.sessionId === nativeSessionId);
            if (info) {
                // Preserve queuedMessages/steeringMessage in the id map so
                // an empty host queue can still remove them later (E3).
                const queue = createQueueProjectionState();
                seedQueueProjection(
                    queue,
                    this.runtime.snapshot(current.handle.chatResource).state as ChatState,
                );
                const record: ProjectionRecord = {
                    ...current,
                    unsubscribe: () => undefined,
                    projection: createProjectionState(),
                    queue,
                    expectedTurns: [],
                    queueLength: 0,
                    approvals: new Set(),
                };
                this.records.set(key, record);
                const unsubscribe = this.source.follow(info.sessionId, (message) =>
                    this.onMessage(key, record, message),
                );
                if (!unsubscribe) {
                    this.records.delete(key);
                    return;
                }
                record.unsubscribe = unsubscribe;
            }
            this.options.persistence?.maybeSave(this.runtime);
            return;
        }
        // No existing record — attach from scratch as before.
        const info = this.source
            .list()
            .find((item) => item.backend === provider && item.sessionId === nativeSessionId);
        if (info) this.attach(key, info);
        this.options.persistence?.maybeSave(this.runtime);
    }

    diagnostics(): { counts: Record<string, number>; recent: AhpProjectionDiagnostic[] } {
        return {
            counts: Object.fromEntries(this.counts),
            recent: this.recent.map((item) => ({ ...item })),
        };
    }

    developerDump(): string {
        return redact(JSON.stringify(this.diagnostics()));
    }

    dispose(): void {
        for (const record of this.records.values()) record.unsubscribe();
        this.records.clear();
        const persistence = this.options.persistence;
        if (persistence) {
            persistence.saveSync(this.runtime);
            persistence.flushSync();
        }
    }

    private attach(key: string, info: AhpProjectionSessionInfo): void {
        let handle = this.runtime.sessionByNative(info.backend, info.sessionId);
        if (!handle) {
            handle = this.runtime.registerSession({
                provider: info.backend,
                nativeSessionId: info.sessionId,
                title: info.title,
                cwd: info.cwd,
            });
        }
        // Seed from any restored snapshot so queuedMessages/steeringMessage
        // rows already in ChatState are tracked, not stranded (E3).
        const queue = createQueueProjectionState();
        seedQueueProjection(queue, this.runtime.snapshot(handle.chatResource).state as ChatState);
        const record: ProjectionRecord = {
            handle,
            unsubscribe: () => undefined,
            projection: createProjectionState(),
            queue,
            expectedTurns: [],
            queueLength: 0,
            approvals: new Set(),
        };
        this.records.set(key, record);
        const unsubscribe = this.source.follow(info.sessionId, (message) =>
            this.onMessage(key, record, message),
        );
        if (!unsubscribe) {
            this.records.delete(key);
            this.runtime.disposeSession(handle.sessionResource);
            return;
        }
        record.unsubscribe = unsubscribe;
    }

    private onMessage(key: string, record: ProjectionRecord, raw: unknown): void {
        try {
            const message = asRecord(raw);
            if (message.type === "user" && typeof message.text === "string") {
                const clientMessageId = optionalString(message.clientMessageId);
                rememberProjectedUser(
                    record.projection,
                    message.text,
                    optionalString(message.model),
                    stringArray(message.attachments),
                    clientMessageId,
                    optionalTimestamp(message.ts),
                );
                // A mid-turn steer has no turn-start to consume the slot
                // above, so echo it into the running turn directly (E1).
                const echo = projectInjectedUser(record.projection, message.text, clientMessageId);
                this.apply(record, echo);
                return;
            }
            if (message.type === "queue" && Array.isArray(message.items)) {
                const items = message.items as PendingMessage[];
                record.queueLength = items.length;
                // Re-seed from the live chat state first. Restored state and
                // older/reconnecting clients may carry pending ids that
                // projectQueue never issued, so its diff would not otherwise
                // remove them. The host queue stays authoritative over every
                // pending row, whoever created it.
                seedQueueProjection(
                    record.queue,
                    this.runtime.snapshot(record.handle.chatResource).state as ChatState,
                );
                this.apply(record, projectQueue(record.queue, items, message.held === true));
                this.reportStrandedPending(key, record, items.length);
                this.compare(key, record);
                return;
            }
            if (message.type === "history" && Array.isArray(message.messages)) {
                const turns = historyTurns(message.messages as HistoryMessage[]);
                this.runtime.dispatch(record.handle.chatResource, {
                    type: "chat/turnsLoaded",
                    turns,
                    replace: message.replace === true,
                    ...(typeof message.nextCursor === "string"
                        ? { turnsNextCursor: message.nextCursor }
                        : {}),
                });
                record.expectedTurns = mergeExpectedTurns(record.expectedTurns, turns, message);
                this.apply(record, []);
                this.compare(key, record);
                return;
            }
            if (message.type !== "event" || !isAgentEvent(message.event)) return;
            if (message.event.kind === "session" && message.event.sessionId) {
                this.replaceNativeSession(key, record, message.event.sessionId);
            }
            this.observeExpected(record, message.event);
            this.apply(record, projectAgentEvent(record.projection, message.event));
            if (message.event.kind === "turn-end" || message.event.kind === "error") {
                this.compare(key, record);
            }
        } catch (error) {
            this.mismatch(
                "projection",
                key,
                error instanceof Error ? error.message : String(error),
            );
        }
        // Persistence must never break the live subscription: a failed save
        // would otherwise kill the observer and silently drop later messages.
        try {
            this.options.persistence?.maybeSave(this.runtime);
        } catch (error) {
            this.mismatch(
                "projection",
                key,
                `persistence: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private apply(record: ProjectionRecord, actions: AhpProjectionAction[]): void {
        for (const projected of actions) {
            const resource =
                projected.channel === "chat"
                    ? record.handle.chatResource
                    : record.handle.sessionResource;
            this.runtime.dispatch(resource, projected.action);
        }
        if (actions.some((item) => item.channel === "chat")) {
            const chat = this.runtime.snapshot(record.handle.chatResource).state as ChatState;
            this.runtime.dispatch(record.handle.sessionResource, {
                type: "session/chatUpdated",
                chat: record.handle.chatResource,
                changes: sessionChatSummaryChanges(chat),
            });
        }
    }

    /** Host queue empty but rows still listed — the ghost row's exact shape.
     *  Names the ids so the producer is identified rather than guessed at. */
    private reportStrandedPending(key: string, record: ProjectionRecord, hostQueued: number): void {
        if (hostQueued > 0) return;
        const chat = this.runtime.snapshot(record.handle.chatResource).state as ChatState;
        const stranded = [
            ...(chat.steeringMessage ? [`${chat.steeringMessage.id} (steering)`] : []),
            ...(chat.queuedMessages ?? []).map((item) => item.id),
        ];
        if (!stranded.length) return;
        this.mismatch("queue", key, `host queue empty, still pending: ${stranded.join(", ")}`);
    }

    private replaceNativeSession(
        key: string,
        record: ProjectionRecord,
        nativeSessionId: string,
    ): void {
        if (record.handle.nativeSessionId === nativeSessionId) return;
        this.runtime.replaceNativeId(record.handle.sessionResource, nativeSessionId);
        this.runtime.dispatch(record.handle.sessionResource, {
            type: "session/metaChanged",
            meta: { symposium: { nativeSessionId } },
        });
        this.runtime.dispatch(record.handle.chatResource, {
            type: "chat/metaChanged",
            meta: { symposium: { nativeSessionId } },
        });
        this.records.delete(key);
        this.records.set(sessionKey(record.handle.provider, nativeSessionId), record);
    }

    private observeExpected(record: ProjectionRecord, event: AgentEvent): void {
        if (event.kind === "turn-start") record.currentText = "";
        if (event.kind === "text" && record.currentText !== undefined) {
            record.currentText += event.text;
        }
        if (event.kind === "approval-request") record.approvals.add(event.toolId);
        if (event.kind === "approval-resolved") record.approvals.delete(event.toolId);
        if (
            (event.kind === "turn-end" || event.kind === "error") &&
            record.currentText !== undefined
        ) {
            record.expectedTurns.push(record.currentText);
            record.currentText = undefined;
        }
    }
    private compare(key: string, record: ProjectionRecord): void {
        const chat = this.runtime.snapshot(record.handle.chatResource).state as ChatState;
        const session = this.runtime.snapshot(record.handle.sessionResource).state as SessionState;
        const actual = chat.turns.map(turnText);
        if (JSON.stringify(actual) !== JSON.stringify(record.expectedTurns)) {
            this.mismatch(
                "transcript",
                key,
                `expected=${record.expectedTurns.length};actual=${actual.length}`,
            );
        }
        const diagnostics = projectionDiagnostics(session, chat);
        if (!diagnostics.statusMatch) this.mismatch("status", key, "session/chat status differs");
        if (!diagnostics.queueMatch || record.queueLength !== (chat.queuedMessages?.length ?? 0)) {
            this.mismatch("queue", key, `expected=${record.queueLength}`);
        }
        if (record.approvals.size !== (session.inputNeeded?.length ?? 0)) {
            this.mismatch("approval", key, `expected=${record.approvals.size}`);
        }
    }

    private mismatch(
        category: AhpProjectionDiagnostic["category"],
        session: string,
        detail: string,
    ): void {
        this.counts.set(category, (this.counts.get(category) ?? 0) + 1);
        this.recent.push({
            category,
            session,
            sequence: this.runtime.store.serverSeq,
            detail: redact(detail),
        });
        if (this.recent.length > this.maximumDiagnostics) this.recent.shift();
        if (category === "queue") {
            this.options.onDiagnostic?.(`queue mismatch ${session}: ${detail}`);
        }
    }
}
