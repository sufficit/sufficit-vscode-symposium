import type { ChatState } from "@microsoft/agent-host-protocol";
import { log } from "./dom";

/** Removes the obsolete live error card once its synthetic retry completes. */
export function removeRecoveredErrorNotice(chat: ChatState, completedTurnId: string): void {
    const index = chat.turns.findIndex((turn) => turn.id === completedTurnId);
    const completed = chat.turns[index] as unknown as {
        message?: { _meta?: { synthetic?: boolean } };
    };
    const recovered = chat.turns[index - 1];
    if (completed?.message?._meta?.synthetic !== true || recovered?.state !== "cancelled") return;
    log.querySelector<HTMLElement>(
        `.turnError[data-turn-id="${CSS.escape(recovered.id)}"]`,
    )?.remove();
}
