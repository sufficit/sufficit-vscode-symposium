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
import { asArray, asRecord, nonNegative, optionalString, stringArray } from "./chatReducerValues";
import { mergeToolMetadata } from "./toolMetadata";

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
                _meta: mergeToolMetadata(tool._meta, action._meta),
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
        case "chat/turnsLoaded": {
            // Prepend newly loaded (older) turns, skipping any whose id already
            // exists in state.turns. This prevents duplication when a session is
            // reopened and its history is reloaded while the AHP snapshot still
            // carries the previously loaded turns.
            const incoming = asArray<Turn>(action.turns);
            const existing = action.replace === true ? [] : state.turns;
            const existingIds = new Set(existing.map((turn) => turn.id));
            const deduped = incoming.filter((turn) => !existingIds.has(turn.id));
            return {
                ...state,
                turns: [...deduped, ...existing],
                turnsNextCursor: optionalString(action.turnsNextCursor),
            };
        }
        default:
            return state;
    }
}

function startTurn(state: ChatState, action: ActionRecord): ChatState {
    const turnId = String(action.turnId ?? "");
    if (!turnId) return state;
    const queuedId = optionalString(action.queuedMessageId);
    const message = action.message as Message;
    // Drop the row by id when there is one; otherwise drop a SINGLE row
    // carrying the same text. queuedMessageId is only present when the
    // projection still held the pendingUser slot, and the first send after an
    // idle period reaches turn-start without it — the row that outlived
    // v25-v33. One row, because the same text may legitimately be queued
    // several times and this turn accounts for exactly one of them.
    const byId = state.queuedMessages?.filter((item) => item.id !== queuedId);
    const queuedMessages =
        byId && byId.length === state.queuedMessages?.length
            ? dropFirstByText(byId, message?.text)
            : byId;
    // A stuck activeTurn (missed turnComplete) must never cause this
    // turnStarted to be dropped whole — that leaves an immortal fake queue
    // row while the user bubble still renders. Supersede: finalize the stuck
    // turn as cancelled (no duration, it never actually finished) and start
    // the new one.
    const turns = state.activeTurn
        ? [...state.turns, finalizeTurn(state.activeTurn, "cancelled", undefined, undefined)]
        : state.turns;
    return {
        ...state,
        turns,
        activeTurn: {
            id: turnId,
            startedAt: String(action.startedAt ?? new Date().toISOString()),
            message,
            responseParts: [],
            usage: undefined,
            // Remembered so a late optimistic pendingMessageSet for the same
            // message can be recognised and refused (see setPending).
            ...(queuedId ? { _meta: { queuedMessageId: queuedId } } : {}),
        },
        draft: undefined,
        queuedMessages: queuedMessages?.length ? queuedMessages : undefined,
        steeringMessage: clearSteering(state.steeringMessage, queuedId, message),
        status: replaceActivityStatus(state.status, AHP_STATUS.inProgress),
        modifiedAt: new Date().toISOString(),
    };
}

/** Clears a steering pending row once its turn has started (by id, or by
 *  text when the queuedMessageId was lost in transit). */
function clearSteering(
    steering: PendingMessage | undefined,
    queuedId: string | undefined,
    message: Message | undefined,
): PendingMessage | undefined {
    if (!steering) return undefined;
    // Same rule as the queued rows: by id when there is one, but always also
    // by text — the id is absent on the first turn after an idle period.
    if (steering.id === queuedId) return undefined;
    return message?.text === steering.message?.text ? undefined : steering;
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
    const turn = finalizeTurn(active, turnState, nonNegative(action.duration), action.error);
    const next: ChatState = {
        ...state,
        turns: [...state.turns, turn],
        activeTurn: undefined,
        activity: undefined,
        status: replaceActivityStatus(state.status, status),
        modifiedAt: new Date().toISOString(),
    };
    // Ghost sweep: turnComplete/turnCancelled prune any pending row left
    // behind with the same text as the turn that just finished. chat/error
    // is excluded — an errored turn's message may legitimately get re-queued.
    return turnState === "error" ? next : pruneGhosts(next, active.message.text);
}

function finalizeTurn(
    active: NonNullable<ChatState["activeTurn"]>,
    turnState: "complete" | "cancelled" | "error",
    duration: number | undefined,
    error: unknown,
): Turn {
    return {
        ...active,
        duration,
        state: turnState,
        error: turnState === "error" ? error : undefined,
    } as Turn;
}

/** Removes pending rows (queued or steering) whose text matches a turn that
 *  already started/finished — an optimistic row that missed its normal
 *  cleanup path. Conservative: exact text match only. */
function pruneGhosts(state: ChatState, finalizedText: string): ChatState {
    const queuedMessages = dropFirstByText(state.queuedMessages, finalizedText);
    const steeringMessage =
        state.steeringMessage?.message?.text === finalizedText ? undefined : state.steeringMessage;
    return {
        ...state,
        queuedMessages: queuedMessages?.length ? queuedMessages : undefined,
        steeringMessage,
    };
}

/**
 * Removes ONE pending row carrying this text, not every one of them.
 * Queueing the same text several times on purpose is normal ("testes" x3), and
 * a text match only ever accounts for the single message the turn is handling.
 */
function dropFirstByText(
    items: readonly PendingMessage[] | undefined,
    text: string | undefined,
): PendingMessage[] | undefined {
    if (!items || !text) return items ? [...items] : undefined;
    const index = items.findIndex((item) => item.message?.text === text);
    if (index < 0) return [...items];
    return [...items.slice(0, index), ...items.slice(index + 1)];
}

function setPending(state: ChatState, action: ActionRecord): ChatState {
    const pending = { id: String(action.id ?? ""), message: action.message as Message };
    if (!pending.id) return state;
    // A queued action from an older/reconnecting client can arrive AFTER the
    // host already routed its send. A direct dispatch may therefore have
    // started the turn before this row lands. Refuse that late row; current
    // clients submit kind:"send" and wait for host queue truth instead.
    if (alreadyStarted(state, pending.id)) return state;
    if (action.kind === "steering") return { ...state, steeringMessage: pending };
    // "send"/"redirect" are dispatched immediately to the backend; they are not
    // queue items and must not be rendered as such. If the backend actually
    // enqueues them (host busy), projectQueue re-projects them as kind:"queued".
    // Treating them as queued here caused the first message to appear both sent
    // and stuck in the queue, because the queue entry was only removed when the
    // subsequent turn-start carried a matching queuedMessageId — a race that
    // fails for the first message of a freshly-attached session.
    if (action.kind === "send" || action.kind === "redirect") return state;
    const queue = (state.queuedMessages ?? []).filter((item) => item.id !== pending.id);
    queue.push(pending);
    return { ...state, queuedMessages: queue };
}

/** True when a turn has already started for this pending id. Matched by id
 *  only — text would suppress a genuine duplicate the user queued on purpose. */
function alreadyStarted(state: ChatState, id: string): boolean {
    const consumed = (turn: unknown): boolean =>
        (turn as { _meta?: { queuedMessageId?: unknown } } | undefined)?._meta?.queuedMessageId ===
        id;
    if (consumed(state.activeTurn)) return true;
    return state.turns.slice(-8).some(consumed);
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
