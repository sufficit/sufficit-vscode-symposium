import type { AgentEvent, HistoryMessage } from "../adapters/types";
import type { PendingMessage } from "../application/controllerQueue";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { AhpHostRuntime, type AhpRuntimeExport, type AhpSessionHandle } from "./hostRuntime";
import { historyTurns, turnText } from "./historyProjection";
import { AhpPersistence } from "./persistence";
import {
    createProjectionState,
    projectAgentEvent,
    rememberProjectedUser,
    type AhpProjectionAction,
    type AhpProjectionState,
} from "./projectAgentEvent";
import {
    createQueueProjectionState,
    projectQueue,
    projectionDiagnostics,
    sessionChatSummaryChanges,
    type QueueProjectionState,
} from "./projectControllerState";

export interface AhpShadowSessionInfo {
    backend: string;
    sessionId: string;
    title: string;
    cwd: string;
}

export interface AhpShadowSource {
    list(): AhpShadowSessionInfo[];
    follow(id: string, observer: (message: unknown) => void): (() => void) | undefined;
}

export interface AhpShadowDiagnostic {
    category: "transcript" | "status" | "queue" | "approval" | "projection";
    session: string;
    sequence: number;
    detail: string;
}

export interface AhpShadowOptions {
    restored?: AhpRuntimeExport;
    persistence?: AhpPersistence;
    replayCapacity?: number;
    maxDiagnostics?: number;
}

interface ShadowRecord {
    handle: AhpSessionHandle;
    unsubscribe: () => void;
    projection: AhpProjectionState;
    queue: QueueProjectionState;
    expectedTurns: string[];
    currentText?: string;
    queueLength: number;
    approvals: Set<string>;
}

export class AhpShadowRuntime {
    readonly runtime: AhpHostRuntime;
    private readonly records = new Map<string, ShadowRecord>();
    private readonly recent: AhpShadowDiagnostic[] = [];
    private readonly counts = new Map<AhpShadowDiagnostic["category"], number>();
    private readonly maximumDiagnostics: number;

    constructor(
        private readonly source: AhpShadowSource,
        private readonly options: AhpShadowOptions = {},
    ) {
        this.runtime = new AhpHostRuntime({
            restored: options.restored,
            replayCapacity: options.replayCapacity,
        });
        this.maximumDiagnostics = positive(options.maxDiagnostics, 100);
    }

    sync(): void {
        const current = new Set<string>();
        for (const info of this.source.list()) {
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

    /** Reprojects one controller after its persisted render log was seeded. */
    rebuild(provider: string, nativeSessionId: string): void {
        const key = sessionKey(provider, nativeSessionId);
        const current = this.records.get(key);
        if (current) {
            current.unsubscribe();
            this.runtime.disposeSession(current.handle.sessionResource);
            this.records.delete(key);
        }
        const info = this.source
            .list()
            .find((item) => item.backend === provider && item.sessionId === nativeSessionId);
        if (info) this.attach(key, info);
        this.options.persistence?.maybeSave(this.runtime);
    }

    diagnostics(): { counts: Record<string, number>; recent: AhpShadowDiagnostic[] } {
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
        this.options.persistence?.save(this.runtime);
    }

    private attach(key: string, info: AhpShadowSessionInfo): void {
        let handle = this.runtime.sessionByNative(info.backend, info.sessionId);
        if (!handle) {
            handle = this.runtime.registerSession({
                provider: info.backend,
                nativeSessionId: info.sessionId,
                title: info.title,
                cwd: info.cwd,
            });
        }
        const record: ShadowRecord = {
            handle,
            unsubscribe: () => undefined,
            projection: createProjectionState(),
            queue: createQueueProjectionState(),
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

    private onMessage(key: string, record: ShadowRecord, raw: unknown): void {
        try {
            const message = asRecord(raw);
            if (message.type === "user" && typeof message.text === "string") {
                rememberProjectedUser(
                    record.projection,
                    message.text,
                    optionalString(message.model),
                    stringArray(message.attachments),
                    optionalString(message.clientMessageId),
                );
                return;
            }
            if (message.type === "queue" && Array.isArray(message.items)) {
                const items = message.items as PendingMessage[];
                record.queueLength = items.length;
                this.apply(record, projectQueue(record.queue, items));
                this.compare(key, record);
                return;
            }
            if (message.type === "history" && Array.isArray(message.messages)) {
                const turns = historyTurns(message.messages as HistoryMessage[]);
                this.runtime.dispatch(record.handle.chatResource, {
                    type: "chat/turnsLoaded",
                    turns,
                });
                record.expectedTurns.push(...turns.map(turnText));
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
        this.options.persistence?.maybeSave(this.runtime);
    }

    private apply(record: ShadowRecord, actions: AhpProjectionAction[]): void {
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

    private replaceNativeSession(key: string, record: ShadowRecord, nativeSessionId: string): void {
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

    private observeExpected(record: ShadowRecord, event: AgentEvent): void {
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

    private compare(key: string, record: ShadowRecord): void {
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
        category: AhpShadowDiagnostic["category"],
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
    }
}

function isAgentEvent(value: unknown): value is AgentEvent {
    return (
        !!value &&
        typeof value === "object" &&
        typeof (value as { kind?: unknown }).kind === "string"
    );
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

function sessionKey(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`;
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function redact(value: string): string {
    return value
        .replace(
            /(authorization|cookie|secret|token|credential)\s*[:=]\s*[^;,}\s]+/gi,
            "$1=[redacted]",
        )
        .slice(0, 1_000);
}
