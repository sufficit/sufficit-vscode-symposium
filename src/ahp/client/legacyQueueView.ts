/** Queue-panel projection for the legacy webview view of AHP chat state. */
import type { ChatState } from "@microsoft/agent-host-protocol";

export function queueItems(chat: ChatState): Record<string, unknown>[] {
    const steering = chat.steeringMessage;
    const head = steering
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
    const rest = (chat.queuedMessages ?? []).map((item) => ({
        id: item.id,
        clientMessageId: item.id,
        text: item.message.text,
        attachments: attachmentValues(item.message.attachments),
    }));
    return [...head, ...rest];
}

/**
 * The host holds the queue after a failed turn: a failure is not a normal
 * continuation point, so pending messages do NOT auto-send. Derived from the
 * last finished turn because ChatState has no hold flag of its own — without
 * it the panel just sits there full and unexplained, which is exactly what a
 * capacity error leaves behind.
 */
export function queueHeld(chat: ChatState): boolean {
    if (chat.activeTurn) return false;
    return chat.turns[chat.turns.length - 1]?.state === "error";
}

export function attachmentValues(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        const record = item as { value?: unknown };
        return typeof record.value === "string" ? [record.value] : [];
    });
}
