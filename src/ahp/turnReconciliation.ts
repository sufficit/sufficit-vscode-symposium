import type { ChatState, Turn } from "@microsoft/agent-host-protocol";

type Submission = Pick<Turn, "message" | "startedAt">;

/** Merges a history page without duplicating existing or currently-live turns. */
export function reconcileLoadedTurns(
    state: Pick<ChatState, "turns" | "activeTurn">,
    incoming: readonly Turn[],
    replace: boolean,
): Turn[] {
    const loaded = withoutSubmissionDuplicate(incoming, state.activeTurn);
    const existing = replace ? [] : state.turns;
    const existingIds = new Set(existing.map((turn) => turn.id));
    return [...loaded.filter((turn) => !existingIds.has(turn.id)), ...existing];
}

/**
 * Removes a history reconstruction of the turn that is already live.
 *
 * Render-log history uses synthetic `history-*` ids, while the live AHP turn
 * uses the provider id, so id-only deduplication cannot recognize them. The
 * original user timestamp is shared by both projections and distinguishes
 * intentionally repeated text sent at different times.
 */
export function withoutSubmissionDuplicate(
    turns: readonly Turn[],
    live: ChatState["activeTurn"] | Submission | undefined,
): Turn[] {
    if (!live) return [...turns];
    return turns.filter((turn) => !sameSubmission(turn, live));
}

function sameSubmission(first: Submission, second: Submission): boolean {
    if (first.message.text !== second.message.text) return false;
    const firstAt = timestamp(first.startedAt);
    const secondAt = timestamp(second.startedAt);
    return firstAt !== undefined && secondAt !== undefined && firstAt === secondAt;
}

function timestamp(value: unknown): number | undefined {
    if (typeof value !== "string") return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
