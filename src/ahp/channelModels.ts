import { pathToFileURL } from "url";
import type {
    AgentInfo,
    ChatState,
    ChatSummary,
    RootState,
    SessionState,
    SessionSummary,
    URI,
} from "@microsoft/agent-host-protocol";
import { AHP_STATUS, statusWithFlags } from "./status";
export { AHP_STATUS, isArchivedStatus, replaceActivityStatus, statusWithFlags } from "./status";

export interface AhpSessionRegistration {
    resource: URI;
    chatResource: URI;
    nativeSessionId: string;
    provider: string;
    title: string;
    cwd?: string;
    permission?: string;
    archived?: boolean;
    createdAt?: string;
}

export interface SymposiumSessionMeta {
    nativeSessionId: string;
    permission?: string;
    queueLength: number;
    capabilities: string[];
}

export function createRootState(agents: AgentInfo[] = []): RootState {
    return {
        agents,
        activeSessions: 0,
        terminals: [],
        _meta: { symposium: { protocol: "0.6.0", capabilities: [] } },
    };
}

export function createSessionState(input: AhpSessionRegistration): SessionState {
    const now = input.createdAt ?? new Date().toISOString();
    const chat = createChatSummary(input.chatResource, input.title, now);
    return {
        provider: input.provider,
        title: input.title,
        status: statusWithFlags(AHP_STATUS.idle, true, input.archived === true),
        lifecycle: "ready",
        workingDirectory: cwdUri(input.cwd),
        activeClients: [],
        chats: [chat],
        defaultChat: input.chatResource,
        _meta: {
            symposium: {
                nativeSessionId: input.nativeSessionId,
                permission: input.permission,
                queueLength: 0,
                capabilities: [],
            } satisfies SymposiumSessionMeta,
            createdAt: now,
        },
    } as SessionState;
}

export function createChatState(input: AhpSessionRegistration): ChatState {
    const now = input.createdAt ?? new Date().toISOString();
    return {
        resource: input.chatResource,
        title: input.title,
        status: statusWithFlags(AHP_STATUS.idle, true, input.archived === true),
        modifiedAt: now,
        workingDirectory: cwdUri(input.cwd),
        turns: [],
        _meta: { symposium: { nativeSessionId: input.nativeSessionId } },
    } as ChatState;
}

export function sessionSummary(
    resource: URI,
    state: SessionState,
    createdAt?: string,
): SessionSummary {
    const timestamp = createdAt ?? metaCreatedAt(state) ?? new Date().toISOString();
    return {
        resource,
        provider: state.provider,
        title: state.title,
        status: state.status,
        activity: state.activity,
        workingDirectory: state.workingDirectory,
        createdAt: timestamp,
        modifiedAt: latestModifiedAt(state),
        _meta: state._meta,
    } as SessionSummary;
}

export function createChatSummary(resource: URI, title: string, modifiedAt: string): ChatSummary {
    return {
        resource,
        title,
        status: statusWithFlags(AHP_STATUS.idle, true, false),
        modifiedAt,
    } as ChatSummary;
}

export function sessionMeta(state: SessionState): SymposiumSessionMeta {
    const raw = (state._meta?.symposium ?? {}) as Partial<SymposiumSessionMeta>;
    return {
        nativeSessionId: raw.nativeSessionId ?? "",
        permission: raw.permission,
        queueLength: raw.queueLength ?? 0,
        capabilities: raw.capabilities ?? [],
    };
}

function cwdUri(cwd: string | undefined): URI | undefined {
    if (!cwd) return undefined;
    try {
        return pathToFileURL(cwd).toString() as URI;
    } catch {
        return undefined;
    }
}

function metaCreatedAt(state: SessionState): string | undefined {
    const value = state._meta?.createdAt;
    return typeof value === "string" ? value : undefined;
}

function latestModifiedAt(state: SessionState): string {
    return state.chats.reduce(
        (latest, chat) => (chat.modifiedAt > latest ? chat.modifiedAt : latest),
        metaCreatedAt(state) ?? new Date().toISOString(),
    );
}
