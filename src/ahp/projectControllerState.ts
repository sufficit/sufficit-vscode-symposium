import type { PendingMessage } from "../application/controllerQueue";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { sessionMeta } from "./channelModels";
import type { AhpProjectionAction } from "./projectAgentEvent";

export interface QueueProjectionState {
    // Kind per id, not just the id: the reducer clears steeringMessage only for
    // kind "steering", so a removal must repeat the kind it was added with.
    ids: Map<string, "steering" | "queued">;
}

export function createQueueProjectionState(): QueueProjectionState {
    return { ids: new Map() };
}

/**
 * Fills a fresh QueueProjectionState from a chat snapshot that already
 * carries queuedMessages/steeringMessage (persisted across a restart, or
 * carried over from an existing record on re-attach). Without this, the
 * projection's id map starts empty even though the reducer-side rows still
 * exist, so a later empty host queue never emits pendingMessageRemoved for
 * them and they strand permanently in ChatState.
 */
export function seedQueueProjection(state: QueueProjectionState, chat: ChatState): void {
    if (chat.steeringMessage?.id) state.ids.set(chat.steeringMessage.id, "steering");
    for (const item of chat.queuedMessages ?? []) {
        if (item.id) state.ids.set(item.id, "queued");
    }
}

export function projectQueue(
    state: QueueProjectionState,
    items: readonly PendingMessage[],
): AhpProjectionAction[] {
    const actions: AhpProjectionAction[] = [];
    const current = new Map<string, "steering" | "queued">();
    for (const [index, item] of items.entries()) {
        const id = queueId(item, index);
        const kind = item.mode === "steer" ? "steering" : "queued";
        current.set(id, kind);
        actions.push({
            channel: "chat",
            action: {
                type: "chat/pendingMessageSet",
                kind,
                id,
                message: {
                    text: item.text,
                    origin: { kind: "user" },
                    model: item.model ? { id: item.model } : undefined,
                    attachments: item.attachments.map((path, attachmentIndex) => ({
                        kind: "simple",
                        id: `${id}:attachment:${attachmentIndex + 1}`,
                        representation: "path",
                        value: path,
                    })),
                },
            },
        });
    }
    for (const [id, kind] of state.ids) {
        if (!current.has(id)) {
            actions.push({
                channel: "chat",
                action: { type: "chat/pendingMessageRemoved", kind, id },
            });
        }
    }
    state.ids = current;
    actions.push({
        channel: "session",
        action: {
            type: "session/metaChanged",
            meta: { symposium: { queueLength: items.length } },
        },
    });
    return actions;
}

export function projectTitle(title: string): AhpProjectionAction[] {
    return [{ channel: "session", action: { type: "session/titleChanged", title } }];
}

export function projectArchive(archived: boolean): AhpProjectionAction[] {
    return [
        { channel: "session", action: { type: "session/isArchivedChanged", isArchived: archived } },
    ];
}

export function sessionChatSummaryChanges(chat: ChatState): Record<string, unknown> {
    return {
        title: chat.title,
        status: chat.status,
        activity: chat.activity,
        modifiedAt: chat.modifiedAt,
        workingDirectory: chat.workingDirectory,
    };
}

export function projectionDiagnostics(
    session: SessionState,
    chat: ChatState,
): { transcriptTurns: number; statusMatch: boolean; queueMatch: boolean } {
    const meta = sessionMeta(session);
    return {
        transcriptTurns: chat.turns.length + (chat.activeTurn ? 1 : 0),
        statusMatch: session.status === chat.status,
        queueMatch: meta.queueLength === (chat.queuedMessages?.length ?? 0),
    };
}

function queueId(item: PendingMessage, index: number): string {
    return item.clientMessageId ?? (item.id != null ? String(item.id) : `queue-${index + 1}`);
}
