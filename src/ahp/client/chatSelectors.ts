import type { ChatState } from "@microsoft/agent-host-protocol";

export interface AhpQueueItem {
    id: string;
    clientMessageId: string;
    text: string;
    attachments: string[];
    mode?: "steer";
}

/** Pending messages in presentation order: steering first, then FIFO queue. */
export function selectPendingMessages(chat: ChatState): AhpQueueItem[] {
    const steering = chat.steeringMessage;
    const head: AhpQueueItem[] = steering
        ? [
              {
                  id: steering.id,
                  clientMessageId: steering.id,
                  text: steering.message.text,
                  attachments: attachmentValues(steering.message.attachments),
                  mode: "steer",
              },
          ]
        : [];
    return [
        ...head,
        ...(chat.queuedMessages ?? []).map((item) => ({
            id: item.id,
            clientMessageId: item.id,
            text: item.message.text,
            attachments: attachmentValues(item.message.attachments),
        })),
    ];
}

/** A failed turn holds queued work until an explicit user action. */
export function isPendingQueueHeld(chat: ChatState): boolean {
    const explicit = [chat.steeringMessage, ...(chat.queuedMessages ?? [])]
        .filter((item) => item !== undefined)
        .map((item) => queueHeld(item.message))
        .find((value) => value !== undefined);
    if (explicit !== undefined) return explicit;
    if (chat.activeTurn) return false;
    return chat.turns[chat.turns.length - 1]?.state === "error";
}

function queueHeld(message: unknown): boolean | undefined {
    const value = (message as { _meta?: { symposium?: { queueHeld?: unknown } } })?._meta?.symposium
        ?.queueHeld;
    return typeof value === "boolean" ? value : undefined;
}

export function attachmentValues(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        const record = item as { value?: unknown; resource?: unknown; label?: unknown };
        if (typeof record.value === "string") return [record.value];
        if (typeof record.resource === "string") return [filePath(record.resource)];
        return typeof record.label === "string" ? [record.label] : [];
    });
}

function filePath(value: string): string {
    try {
        const url = new URL(value);
        return url.protocol === "file:" ? decodeURIComponent(url.pathname) : value;
    } catch {
        return value;
    }
}
