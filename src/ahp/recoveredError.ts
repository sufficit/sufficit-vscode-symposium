import type { ChatState } from "@microsoft/agent-host-protocol";

type AhpTurn = ChatState["turns"][number];
type MetadataOwner = { _meta?: Record<string, unknown> };

/** A successful retry supersedes the failed attempt without erasing its output. */
export function settleRecoveredError(
    turns: ChatState["turns"],
    completed: AhpTurn,
): ChatState["turns"] {
    const previous = turns.at(-1);
    if (
        (completed.message as MetadataOwner)._meta?.synthetic !== true ||
        previous?.state !== "error"
    ) {
        return turns;
    }
    return [
        ...turns.slice(0, -1),
        { ...previous, state: "cancelled", error: undefined } as AhpTurn,
    ];
}

/** Later assistant/tool progress proves a historical terminal error recovered. */
export function resumeHistoricalTurn(turn: AhpTurn): void {
    if (turn.state !== "error") return;
    turn.state = "complete" as AhpTurn["state"];
    turn.error = undefined;
}
