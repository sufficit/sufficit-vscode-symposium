import type { PendingMessage } from "./controllerQueue";
import { transcriptMessages } from "./controllerTranscript";
import type { Turn } from "./turn";

/**
 * Reconstructs the current request after an Extension Host hand-off. The
 * durable user row is reused while the adapter keeps the existing session
 * history and model/options; automatic recovery therefore never emits a
 * duplicate user row to the agent.
 */
export function recoverableMessage(
    messages: readonly unknown[],
    turn: Turn,
): PendingMessage | undefined {
    const rows = transcriptMessages([...messages]);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.role === "user" && row.text.trim()) {
            return {
                text: row.text,
                attachments: [],
                ...(turn.intentId ? { intentId: turn.intentId } : {}),
            };
        }
    }
    return undefined;
}
