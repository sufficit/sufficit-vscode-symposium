import type {
    AgentInfo,
    ChatSummary,
    RootState,
    SessionActiveClient,
    SessionState,
    StateAction,
} from "@microsoft/agent-host-protocol";
import { AHP_STATUS, isArchivedStatus, replaceActivityStatus } from "./status";

type ActionRecord = { type: string } & Record<string, unknown>;

export function rootReducer(state: RootState, raw: StateAction): RootState {
    const action = raw as unknown as ActionRecord;
    switch (action.type) {
        case "root/agentsChanged":
            return { ...state, agents: asArray<AgentInfo>(action.agents) };
        case "root/activeSessionsChanged":
            return { ...state, activeSessions: asNumber(action.activeSessions) };
        case "root/terminalsChanged":
            return { ...state, terminals: asArray(action.terminals) };
        case "root/configChanged": {
            const values = asRecord(action.config);
            const current = state.config ?? {
                schema: { type: "object" as const, properties: {} },
                values: {},
            };
            return {
                ...state,
                config: {
                    ...current,
                    values: action.replace ? values : { ...current.values, ...values },
                },
            };
        }
        case "root/metaChanged":
            return {
                ...state,
                _meta: mergeMeta(state._meta, asRecord(action.meta)),
            } as RootState;
        default:
            return state;
    }
}

export function sessionReducer(state: SessionState, raw: StateAction): SessionState {
    const action = raw as unknown as ActionRecord;
    switch (action.type) {
        case "session/ready":
            return { ...state, lifecycle: "ready", creationError: undefined } as SessionState;
        case "session/creationFailed":
            return {
                ...state,
                lifecycle: "creationFailed",
                creationError: action.error,
                status: replaceActivityStatus(state.status, AHP_STATUS.error),
            } as SessionState;
        case "session/chatAdded":
            return withChats(state, upsertChat(state.chats, action.summary as ChatSummary));
        case "session/chatRemoved":
            return withChats(
                state,
                state.chats.filter((chat) => chat.resource !== action.chat),
            );
        case "session/chatUpdated":
            return updateChat(state, String(action.chat ?? ""), asRecord(action.changes));
        case "session/defaultChatChanged":
            return { ...state, defaultChat: action.defaultChat as SessionState["defaultChat"] };
        case "session/titleChanged":
            return { ...state, title: String(action.title ?? "") };
        case "session/isReadChanged":
            return {
                ...state,
                status: setFlag(state.status, AHP_STATUS.isRead, action.isRead === true),
            };
        case "session/isArchivedChanged":
            return {
                ...state,
                status: setFlag(state.status, AHP_STATUS.isArchived, action.isArchived === true),
            };
        case "session/activityChanged":
            return { ...state, activity: optionalString(action.activity) };
        case "session/serverToolsChanged":
            return { ...state, serverTools: asArray(action.tools) } as SessionState;
        case "session/activeClientSet":
            return setActiveClient(state, action.activeClient as SessionActiveClient);
        case "session/activeClientRemoved":
            return {
                ...state,
                activeClients: state.activeClients.filter(
                    (client) => client.clientId !== action.clientId,
                ),
            };
        case "session/inputNeededSet":
            return upsertInput(state, action.request);
        case "session/inputNeededRemoved":
            return {
                ...state,
                inputNeeded: state.inputNeeded?.filter((item) => item.id !== action.id),
            };
        case "session/customizationsChanged":
            return { ...state, customizations: asArray(action.customizations) } as SessionState;
        case "session/changesetsChanged":
            return { ...state, changesets: action.changesets as SessionState["changesets"] };
        case "session/configChanged":
            return updateConfig(state, action);
        case "session/metaChanged":
            return mergeSessionMeta(state, asRecord(action.meta));
        default:
            return state;
    }
}

function mergeSessionMeta(state: SessionState, changes: Record<string, unknown>): SessionState {
    const symposium = asRecord(changes.symposium);
    return {
        ...state,
        _meta: {
            ...state._meta,
            ...changes,
            symposium: {
                ...asRecord(state._meta?.symposium),
                ...symposium,
            },
        },
    } as SessionState;
}

function withChats(state: SessionState, chats: ChatSummary[]): SessionState {
    const status = aggregateStatus(chats, state.status);
    return { ...state, chats, status };
}

function updateChat(
    state: SessionState,
    resource: string,
    changes: Record<string, unknown>,
): SessionState {
    const chats = state.chats.map((chat) =>
        chat.resource === resource
            ? ({ ...chat, ...changes, resource: chat.resource } as ChatSummary)
            : chat,
    );
    return withChats(state, chats);
}

function upsertChat(chats: ChatSummary[], summary: ChatSummary): ChatSummary[] {
    const index = chats.findIndex((chat) => chat.resource === summary.resource);
    if (index < 0) return [...chats, summary];
    const next = [...chats];
    next[index] = summary;
    return next;
}

function aggregateStatus(chats: ChatSummary[], current: number): number {
    let base: number = AHP_STATUS.idle;
    if (chats.some((chat) => (chat.status & AHP_STATUS.inputNeeded) === AHP_STATUS.inputNeeded)) {
        base = AHP_STATUS.inputNeeded;
    } else if (chats.some((chat) => (chat.status & AHP_STATUS.inProgress) !== 0)) {
        base = AHP_STATUS.inProgress;
    } else if (chats.some((chat) => (chat.status & AHP_STATUS.error) !== 0)) {
        base = AHP_STATUS.error;
    }
    return replaceActivityStatus(current, base);
}

function setActiveClient(state: SessionState, client: SessionActiveClient): SessionState {
    if (!client?.clientId) return state;
    const activeClients = state.activeClients.filter((item) => item.clientId !== client.clientId);
    activeClients.push(client);
    return { ...state, activeClients };
}

function upsertInput(state: SessionState, value: unknown): SessionState {
    const request = value as NonNullable<SessionState["inputNeeded"]>[number];
    if (!request?.id) return state;
    const inputNeeded = (state.inputNeeded ?? []).filter((item) => item.id !== request.id);
    inputNeeded.push(request);
    return { ...state, inputNeeded };
}

function updateConfig(state: SessionState, action: ActionRecord): SessionState {
    const values = asRecord(action.config);
    const current = state.config ?? {
        schema: { type: "object" as const, properties: {} },
        values: {},
    };
    return {
        ...state,
        config: {
            ...current,
            values: action.replace ? values : { ...current.values, ...values },
        },
    } as SessionState;
}

function setFlag(status: number, flag: number, enabled: boolean): number {
    return enabled ? status | flag : status & ~flag;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mergeMeta(
    current: RootState["_meta"],
    changes: Record<string, unknown>,
): NonNullable<RootState["_meta"]> {
    return {
        ...current,
        ...changes,
        symposium: {
            ...asRecord(current?.symposium),
            ...asRecord(changes.symposium),
        },
    };
}

export function sessionIsArchived(state: SessionState): boolean {
    return isArchivedStatus(state.status);
}
