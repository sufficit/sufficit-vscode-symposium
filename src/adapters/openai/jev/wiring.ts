/**
 * Session wiring for the jev between-turns prune. The TurnRunner already
 * carries everything the prune needs (cfg, messages, turn/token counters,
 * auth, emit, persist), so this module projects TurnRunnerDeps onto the
 * prune's own deps instead of threading a jev-specific member through the
 * runner interface. Per-session bookkeeping (in-flight lock + cooldown stamp)
 * lives in a WeakMap keyed by the session's stable deps object.
 */

import type { AgentEvent } from "../../types";
import type { TurnRunnerDeps } from "../turnRunnerDeps";
import { maybeJevPrune } from "./betweenTurns";

type JevSessionState = { inFlight: boolean; lastAttemptMs: number };

const sessionStates = new WeakMap<TurnRunnerDeps, JevSessionState>();

function stateFor(deps: TurnRunnerDeps): JevSessionState {
    let state = sessionStates.get(deps);
    if (!state) {
        state = { inFlight: false, lastAttemptMs: 0 };
        sessionStates.set(deps, state);
    }
    return state;
}

function jevPruneAfterTurn(deps: TurnRunnerDeps): void {
    void maybeJevPrune(
        {
            sessionId: deps.sessionId,
            cfg: deps.cfg,
            getMessages: deps.getMessages,
            getTurnNo: deps.getTurnNo,
            getLastInputTokens: deps.getLastInputTokens,
            contextWindow: deps.contextWindow,
            authToken: deps.authToken,
            emit: (event) => deps.emit(event as unknown as AgentEvent),
            safePersist: () => deps.safePersist(),
            settings: () => deps.cfg.jev,
            model: () => deps.model(),
        },
        stateFor(deps),
    ).catch(() => undefined);
}

/**
 * Turn-end settle point: auto-compaction first, then the jev between-turns
 * prune once compaction has settled, so the two never rewrite the live
 * messages concurrently. Fire-and-forget; every failure is muted (the prune
 * itself is fail-safe and never throws past here).
 */
export function settleAutoCompactAndJev(deps: TurnRunnerDeps): void {
    void deps
        .maybeAutoCompact()
        .catch(() => undefined)
        .finally(() => {
            jevPruneAfterTurn(deps);
        });
}
