import { randomUUID } from "crypto";
import type {
    ActionEnvelope,
    ActionOrigin,
    AgentInfo,
    ChatState,
    RootState,
    SessionState,
    SessionSummary,
    Snapshot,
    StateAction,
    URI,
} from "@microsoft/agent-host-protocol";
import { AhpStateStore, type AhpReconnectResult } from "./channelStore";
import {
    createChatState,
    createRootState,
    createSessionState,
    sessionSummary,
    type AhpSessionRegistration,
} from "./channelModels";
import { AHP_ROOT_URI, chatUri, parseAhpUri, sessionUri, stableAhpUuid } from "./channelUris";
import { chatReducer } from "./chatReducer";
import { sanitizeRestoredChatState, sanitizeRestoredSessionState } from "./restoredState";
import { rootReducer, sessionReducer } from "./stateReducers";

export interface AhpSessionHandle {
    nativeSessionId: string;
    provider: string;
    sessionId: string;
    chatId: string;
    sessionResource: URI;
    chatResource: URI;
    createdAt: string;
}

export interface AhpRuntimeExport {
    serverSeq: number;
    sessions: AhpSessionHandle[];
    snapshots: Snapshot[];
    retainedActions: ActionEnvelope[];
}

export interface AhpHostRuntimeOptions {
    agents?: AgentInfo[];
    replayCapacity?: number;
    restored?: AhpRuntimeExport;
    onListenerError?: (error: unknown, envelope: ActionEnvelope) => void;
}

export class AhpHostRuntime {
    readonly store: AhpStateStore;
    private readonly sessions = new Map<URI, AhpSessionHandle>();
    private readonly nativeSessions = new Map<string, AhpSessionHandle>();

    constructor(options: AhpHostRuntimeOptions = {}) {
        this.store = new AhpStateStore({
            replayCapacity: options.replayCapacity,
            onListenerError: options.onListenerError,
        });
        if (options.restored) {
            this.restore(options.restored, options.agents);
        } else {
            this.store.register(AHP_ROOT_URI, createRootState(options.agents), rootReducer);
        }
    }

    registerSession(
        input: Omit<AhpSessionRegistration, "resource" | "chatResource"> & {
            stableId?: string;
            chatId?: string;
        },
    ): AhpSessionHandle {
        const key = nativeKey(input.provider, input.nativeSessionId);
        if (this.nativeSessions.has(key)) {
            throw new Error(`AHP session already registered: ${key}`);
        }
        const sessionId = input.stableId ?? idForNative("session", key);
        const defaultChatId = input.chatId ?? stableAhpUuid(`chat:${sessionId}`);
        const handle: AhpSessionHandle = {
            nativeSessionId: input.nativeSessionId,
            provider: input.provider,
            sessionId,
            chatId: defaultChatId,
            sessionResource: sessionUri(sessionId),
            chatResource: chatUri(defaultChatId),
            createdAt: input.createdAt ?? new Date().toISOString(),
        };
        const registration: AhpSessionRegistration = {
            ...input,
            resource: handle.sessionResource,
            chatResource: handle.chatResource,
            createdAt: handle.createdAt,
        };
        this.store.register(
            handle.sessionResource,
            createSessionState(registration),
            sessionReducer,
        );
        try {
            this.store.register(handle.chatResource, createChatState(registration), chatReducer);
        } catch (error) {
            this.store.remove(handle.sessionResource);
            throw error;
        }
        this.addHandle(handle);
        this.emitActiveSessionCount();
        return handle;
    }

    disposeSession(resourceOrNativeId: string): boolean {
        const handle = this.findSession(resourceOrNativeId);
        if (!handle) return false;
        for (const resource of this.store.resources()) {
            if (
                resource === handle.sessionResource ||
                resource === handle.chatResource ||
                resource.startsWith(`${handle.sessionResource}/`)
            ) {
                this.store.remove(resource);
            }
        }
        this.sessions.delete(handle.sessionResource);
        this.nativeSessions.delete(nativeKey(handle.provider, handle.nativeSessionId));
        this.emitActiveSessionCount();
        return true;
    }

    replaceNativeId(resource: URI, nativeSessionId: string): void {
        const handle = this.sessions.get(resource);
        if (!handle || handle.nativeSessionId === nativeSessionId) return;
        this.nativeSessions.delete(nativeKey(handle.provider, handle.nativeSessionId));
        handle.nativeSessionId = nativeSessionId;
        this.nativeSessions.set(nativeKey(handle.provider, nativeSessionId), handle);
    }

    setAgents(agents: AgentInfo[]): ActionEnvelope {
        return this.dispatch(AHP_ROOT_URI, { type: "root/agentsChanged", agents });
    }

    dispatch(
        resource: URI,
        action: Record<string, unknown>,
        options: { origin?: ActionOrigin; rejectionReason?: string } = {},
    ): ActionEnvelope {
        return this.store.dispatch(resource, action as unknown as StateAction, options);
    }

    snapshot(resource: URI): Snapshot {
        return this.store.snapshot(resource);
    }

    snapshots(resources: readonly URI[]): { snapshots: Snapshot[]; missing: URI[] } {
        return this.store.snapshots(resources);
    }

    subscribe(resource: URI, listener: (envelope: ActionEnvelope) => void): () => void {
        return this.store.subscribe(resource, listener);
    }

    reconnect(lastSeenServerSeq: number, resources: readonly URI[]): AhpReconnectResult {
        return this.store.reconnect(lastSeenServerSeq, resources);
    }

    listSessions(): SessionSummary[] {
        return [...this.sessions.values()].map((handle) =>
            sessionSummary(
                handle.sessionResource,
                this.snapshot(handle.sessionResource).state as SessionState,
                handle.createdAt,
            ),
        );
    }

    handles(): AhpSessionHandle[] {
        return [...this.sessions.values()].map((handle) => ({ ...handle }));
    }

    sessionByNative(provider: string, nativeSessionId: string): AhpSessionHandle | undefined {
        return this.nativeSessions.get(nativeKey(provider, nativeSessionId));
    }

    sessionByResource(resource: URI): AhpSessionHandle | undefined {
        return this.sessions.get(resource);
    }

    findSession(resourceOrNativeId: string): AhpSessionHandle | undefined {
        const direct = this.sessions.get(resourceOrNativeId as URI);
        if (direct) return direct;
        return [...this.sessions.values()].find(
            (handle) =>
                handle.nativeSessionId === resourceOrNativeId ||
                handle.chatResource === resourceOrNativeId,
        );
    }

    registerChannel(resource: URI, initialState: Snapshot["state"]): void {
        if (this.store.has(resource))
            throw new Error(`AHP channel already registered: ${resource}`);
        parseAhpUri(resource);
        this.store.register(resource, initialState, genericReducer);
    }

    exportState(): AhpRuntimeExport {
        return {
            serverSeq: this.store.serverSeq,
            sessions: this.handles(),
            snapshots: this.store.allSnapshots(),
            retainedActions: this.store.retainedActions(),
        };
    }

    private restore(restored: AhpRuntimeExport, agents: AgentInfo[] | undefined): void {
        const snapshots = new Map(restored.snapshots.map((item) => [item.resource, item]));
        const root = snapshots.get(AHP_ROOT_URI);
        this.store.register(
            AHP_ROOT_URI,
            (root?.state as RootState | undefined) ?? createRootState(agents),
            rootReducer,
        );
        snapshots.delete(AHP_ROOT_URI);
        for (const handle of restored.sessions) {
            const session = snapshots.get(handle.sessionResource);
            const chat = snapshots.get(handle.chatResource);
            if (!session || !chat) throw new Error("Persisted AHP session is missing channels");
            this.store.register(
                handle.sessionResource,
                sanitizeRestoredSessionState(session.state as SessionState),
                sessionReducer,
            );
            this.store.register(
                handle.chatResource,
                sanitizeRestoredChatState(chat.state as ChatState),
                chatReducer,
            );
            snapshots.delete(handle.sessionResource);
            snapshots.delete(handle.chatResource);
            this.addHandle({ ...handle });
        }
        for (const snapshot of snapshots.values()) {
            parseAhpUri(snapshot.resource);
            this.store.register(snapshot.resource, snapshot.state, genericReducer);
        }
        this.store.restoreClock(restored.serverSeq, restored.retainedActions);
    }

    private addHandle(handle: AhpSessionHandle): void {
        this.sessions.set(handle.sessionResource, handle);
        this.nativeSessions.set(nativeKey(handle.provider, handle.nativeSessionId), handle);
    }

    private emitActiveSessionCount(): void {
        this.dispatch(AHP_ROOT_URI, {
            type: "root/activeSessionsChanged",
            activeSessions: this.sessions.size,
        });
    }
}

function nativeKey(provider: string, nativeSessionId: string): string {
    return `${provider}:${nativeSessionId}`;
}

function idForNative(kind: string, key: string): string {
    return key.includes(":new-") ? randomUUID() : stableAhpUuid(`${kind}:${key}`);
}

function genericReducer(state: Snapshot["state"], action: StateAction): Snapshot["state"] {
    const record = action as unknown as Record<string, unknown>;
    if (record.type === "symposium/channelStateChanged") {
        return record.replace === true
            ? (record.state as Snapshot["state"])
            : ({ ...state, ...(record.state as Record<string, unknown>) } as Snapshot["state"]);
    }
    return state;
}
