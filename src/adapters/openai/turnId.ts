/**
 * Stable turn identity for an OpenAISession.
 *
 * A logical turn = one user message → one full assistant tool-calling
 * round-trip. The numeric `turnNo` (an in-memory counter that resets on every
 * session reopen) is NOT a stable identity: the same session reopens with
 * turnNo=0 each time, so ledger rows written before the reload carry stale
 * indices and a retry/resume can't be associated with the right logical turn.
 *
 * `logicalTurnId` is stable across retries and reopen: it is derived from the
 * (stable) sessionId + a monotonic sequence persisted in the session's
 * `meta.json`, and reconstructed from the ledger on resume. `attemptId`
 * identifies one model POST within a turn (one hop), so a multi-hop turn and a
 * retried turn are distinguishable and observable.
 *
 * This module is deliberately free of any "intent" semantics: it produces
 * deterministic ids only. Classification of how a message relates to the
 * previous one (new / continue / retry / redirect) belongs to a future Intent
 * Arbiter, not here.
 */

/** Separator between the session id and the turn sequence in a logicalTurnId. */
const TURN_SEP = "/turn-";
/** Separator between the logical turn id and the attempt number. */
const ATTEMPT_SEP = "/attempt-";

/**
 * Builds a stable logical turn id from a session id and a monotonic sequence
 * number. The format is human-readable (`<sessionId>/turn-<n>`) so it shows up
 * sensibly in `git log` commit subjects and ledger rows.
 */
export function makeLogicalTurnId(sessionId: string, seq: number): string {
    return `${sessionId}${TURN_SEP}${seq}`;
}

/**
 * Builds an attempt id for the n-th model POST (hop) within a logical turn.
 * `n` is 1-based (the first POST of a turn is attempt-1).
 */
export function makeAttemptId(logicalTurnId: string, n: number): string {
    return `${logicalTurnId}${ATTEMPT_SEP}${n}`;
}

/**
 * Extracts the monotonic sequence number from a logicalTurnId, or undefined
 * when the id is missing the `turn-` segment (e.g. a legacy row written before
 * logicalTurnIds existed). Used to reconstruct the last-used seq from the
 * ledger as a fallback when `meta.json` is unavailable or corrupt.
 */
export function parseTurnSeq(logicalTurnId: string | undefined | null): number | undefined {
    if (typeof logicalTurnId !== "string") { return undefined; }
    const idx = logicalTurnId.lastIndexOf(TURN_SEP);
    if (idx < 0) { return undefined; }
    const n = Number(logicalTurnId.slice(idx + TURN_SEP.length));
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Extracts the attempt number from an attemptId, or undefined when absent.
 */
export function parseAttemptNo(attemptId: string | undefined | null): number | undefined {
    if (typeof attemptId !== "string") { return undefined; }
    const idx = attemptId.lastIndexOf(ATTEMPT_SEP);
    if (idx < 0) { return undefined; }
    const n = Number(attemptId.slice(idx + ATTEMPT_SEP.length));
    return Number.isFinite(n) && n > 0 ? n : undefined;
}
