import type {
    ChatState,
    Message,
    PendingMessage,
    ResponsePart,
    StateAction,
    Turn,
    UsageInfo,
} from "@microsoft/agent-host-protocol";
import { AHP_STATUS, replaceActivityStatus } from "./status";

type ActionRecord = { type: string } & Record<string, unknown>;
type PartRecord = Record<string, unknown> & {
    kind: string;
    id?: string;
    content?: string;
    toolCall?: ToolRecord;
};
type ToolRecord = Record<string, unknown> & {
    toolCallId: string;
    status: string;
};

export function chatReducer(state: ChatState, raw: StateAction): ChatState {
    const action = raw as unknown as ActionRecord;
    switch (action.type) {
        case "chat/turnStarted":
            return startTurn(state, action);
        case "chat/responsePart":
            return appendPart(state, action);
        case "chat/delta":
            return appendPartContent(state, action, "markdown");
        case "chat/reasoning":
            return appendPartContent(state, action, "reasoning");
        case "chat/toolCallStart":
            return startTool(state, action);
        case "chat/toolCallDelta":
            return updateTool(state, action, (tool) => ({
                ...tool,
                toolInput: String(tool.toolInput ?? "") + String(action.content ?? ""),
                invocationMessage: action.invocationMessage ?? tool.invocationMessage,
            }));
        case "chat/toolCallReady":
            return updateTool(state, action, (tool) => ({
                ...tool,
                status: action.confirmed ? "running" : "pending-confirmation",
                invocationMessage: action.invocationMessage,
                toolInput: action.toolInput,
                confirmationTitle: action.confirmationTitle,
                confirmed: action.confirmed,
            }));
        case "chat/toolCallConfirmed":
            return updateTool(state, action, (tool) => ({
                ...tool,
                status: action.approved === true ? "running" : "cancelled",
                confirmed: action.confirmed,
                reason: action.reason,
            }));
        case "chat/toolCallContentChanged":
            return updateTool(state, action, (tool) => ({ ...tool, content: action.content }));
        case "chat/toolCallComplete":
            return updateTool(state, action, (tool) => ({
                ...tool,
                status: "completed",
                result: action.result,
            }));
        case "chat/toolCallResultConfirmed":
            return updateTool(state, action, (tool) => ({
                ...tool,
                status: action.approved === false ? "cancelled" : "completed",
            }));
        case "chat/activityChanged":
            return { ...state, activity: optionalString(action.activity) };
        case "chat/usage":
            return updateActive(state, String(action.turnId ?? ""), (turn) => ({
                ...turn,
                usage: action.usage as UsageInfo,
            }));
        case "chat/turnComplete":
            return endTurn(state, action, "complete", AHP_STATUS.idle);
        case "chat/turnCancelled":
            return endTurn(state, action, "cancelled", AHP_STATUS.idle);
        case "chat/error":
            return endTurn(state, action, "error", AHP_STATUS.error);
        case "chat/pendingMessageSet":
            return setPending(state, action);
        case "chat/pendingMessageRemoved":
            return removePending(state, action);
        case "chat/queuedMessagesReordered":
            return reorderQueue(state, stringArray(action.order));
        case "chat/draftChanged":
            return { ...state, draft: action.draft as Message | undefined };
        case "chat/metaChanged":
            return {
                ...state,
                _meta: { ...state._meta, ...asRecord(action.meta) },
            } as ChatState;
        case "chat/truncated":
            return truncate(state, optionalString(action.turnId));
        case "chat/turnsLoaded":
            return {
                ...state,
                turns: [...asArray<Turn>(action.turns), ...state.turns],
                turnsNextCursor: optionalString(action.turnsNextCursor),
            };
        default:
            return state;
    }
}

function startTurn(state: ChatState, action: ActionRecord): ChatState {
    const turnId = String(action.turnId ?? "");
    if (!turnId || state.activeTurn) return state;
    const queuedId = optionalString(action.queuedMessageId);
    const queuedMessages = queuedId
        ? state.queuedMessages?.filter((item) => item.id !== queuedId)
        : state.queuedMessages;
    return {
        ...state,
        activeTurn: {
            id: turnId,
            startedAt: String(action.startedAt ?? new Date().toISOString()),
            message: action.message as Message,
            responseParts: [],
            usage: undefined,
        },
        draft: undefined,
        queuedMessages: queuedMessages?.length ? queuedMessages : undefined,
        status: replaceActivityStatus(state.status, AHP_STATUS.inProgress),
        modifiedAt: new Date().toISOString(),
    };
}

function appendPart(state: ChatState, action: ActionRecord): ChatState {
    return updateActive(state, String(action.turnId ?? ""), (turn) => ({
        ...turn,
        responseParts: [...turn.responseParts, action.part as ResponsePart],
    }));
}

function appendPartContent(
    state: ChatState,
    action: ActionRecord,
    expectedKind: "markdown" | "reasoning",
): ChatState {
    const partId = String(action.partId ?? "");
    return updateParts(state, String(action.turnId ?? ""), (parts) =>
        parts.map((part) => {
            const record = part as unknown as PartRecord;
            if (record.kind !== expectedKind || record.id !== partId) return part;
            return {
                ...record,
                content: String(record.content ?? "") + String(action.content ?? ""),
            } as unknown as ResponsePart;
        }),
    );
}

function startTool(state: ChatState, action: ActionRecord): ChatState {
    const toolCallId = String(action.toolCallId ?? "");
    if (!toolCallId) return state;
    const part = {
        kind: "toolCall",
        toolCall: {
            toolCallId,
            toolName: String(action.toolName ?? "tool"),
            displayName: String(action.displayName ?? action.toolName ?? "Tool"),
            intention: optionalString(action.intention),
            contributor: action.contributor,
            status: "streaming",
            _meta: action._meta,
        },
    } as unknown as ResponsePart;
    return updateActive(state, String(action.turnId ?? ""), (turn) => ({
        ...turn,
        responseParts: [...turn.responseParts, part],
    }));
}

function updateTool(
    state: ChatState,
    action: ActionRecord,
    change: (tool: ToolRecord) => ToolRecord,
): ChatState {
    const toolCallId = String(action.toolCallId ?? "");
    return updateParts(state, String(action.turnId ?? ""), (parts) =>
        parts.map((part) => {
            const record = part as unknown as PartRecord;
            if (record.kind !== "toolCall" || record.toolCall?.toolCallId !== toolCallId) {
                return part;
            }
            return { ...record, toolCall: change(record.toolCall) } as unknown as ResponsePart;
        }),
    );
}

function endTurn(
    state: ChatState,
    action: ActionRecord,
    turnState: "complete" | "cancelled" | "error",
    status: number,
): ChatState {
    const active = state.activeTurn;
    if (!active || active.id !== action.turnId) return state;
    const turn = {
        ...active,
        duration: nonNegative(action.duration),
        state: turnState,
        error: turnState === "error" ? action.error : undefined,
    } as Turn;
    return {
        ...state,
        turns: [...state.turns, turn],
        activeTurn: undefined,
        activity: undefined,
        status: replaceActivityStatus(state.status, status),
        modifiedAt: new Date().toISOString(),
    };
}

function setPending(state: ChatState, action: ActionRecord): ChatState {
    const pending = { id: String(action.id ?? ""), message: action.message as Message };
    if (!pending.id) return state;
    if (action.kind === "steering") return { ...state, steeringMessage: pending };
    const queue = (state.queuedMessages ?? []).filter((item) => item.id !== pending.id);
    queue.push(pending);
    return { ...state, queuedMessages: queue };
}

function removePending(state: ChatState, action: ActionRecord): ChatState {
    const id = String(action.id ?? "");
    if (action.kind === "steering") {
        return state.steeringMessage?.id === id ? { ...state, steeringMessage: undefined } : state;
    }
    const queue = state.queuedMessages?.filter((item) => item.id !== id);
    return { ...state, queuedMessages: queue?.length ? queue : undefined };
}

function reorderQueue(state: ChatState, order: string[]): ChatState {
    const current = state.queuedMessages ?? [];
    const byId = new Map(current.map((item) => [item.id, item]));
    const next: PendingMessage[] = [];
    for (const id of order) {
        const item = byId.get(id);
        if (item) {
            next.push(item);
            byId.delete(id);
        }
    }
    next.push(...byId.values());
    return { ...state, queuedMessages: next.length ? next : undefined };
}

function truncate(state: ChatState, turnId: string | undefined): ChatState {
    if (!turnId) return { ...state, turns: [], activeTurn: undefined };
    const index = state.turns.findIndex((turn) => turn.id === turnId);
    return index < 0 ? state : { ...state, turns: state.turns.slice(0, index + 1) };
}

function updateParts(
    state: ChatState,
    turnId: string,
    change: (parts: ResponsePart[]) => ResponsePart[],
): ChatState {
    return updateActive(state, turnId, (turn) => ({
        ...turn,
        responseParts: change(turn.responseParts),
    }));
}

function updateActive(
    state: ChatState,
    turnId: string,
    change: (turn: NonNullable<ChatState["activeTurn"]>) => NonNullable<ChatState["activeTurn"]>,
): ChatState {
    if (!state.activeTurn || state.activeTurn.id !== turnId) return state;
    return { ...state, activeTurn: change(state.activeTurn), modifiedAt: new Date().toISOString() };
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function nonNegative(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
