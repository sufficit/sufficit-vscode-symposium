import type { ChatState, ChatSummary, SessionState } from "@microsoft/agent-host-protocol";
import { AHP_STATUS, replaceActivityStatus } from "./status";

/**
 * Removes process-local state from a persisted chat snapshot. Durable user
 * state (history, drafts and the host-projected queue) is intentionally kept.
 */
export function sanitizeRestoredChatState(state: ChatState): ChatState {
    return {
        ...state,
        status: withoutTransientActivity(state.status),
        activity: undefined,
        activeTurn: undefined,
        turns: [...state.turns],
        queuedMessages: state.queuedMessages ? [...state.queuedMessages] : undefined,
    };
}

/** Drops connections, approvals and busy indicators that died with the host. */
export function sanitizeRestoredSessionState(state: SessionState): SessionState {
    return {
        ...state,
        status: withoutTransientActivity(state.status),
        activity: undefined,
        activeClients: [],
        inputNeeded: undefined,
        chats: state.chats.map(sanitizeRestoredChatSummary),
    };
}

function sanitizeRestoredChatSummary(chat: ChatSummary): ChatSummary {
    return {
        ...chat,
        status: withoutTransientActivity(chat.status),
        activity: undefined,
    };
}

function withoutTransientActivity(status: number): number {
    return (status & AHP_STATUS.inProgress) !== 0
        ? replaceActivityStatus(status, AHP_STATUS.idle)
        : status;
}
