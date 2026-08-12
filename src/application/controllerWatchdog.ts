/** Application turn watchdog.
 *
 * Silence watchdog: force-ends a turn that produces no events for too long, so a
 * stalled tool call or dropped backend connection can't pin the session as
 * "working" forever (it survives reloads since the controller outlives them).
 * Reset by every event, so long but active tools/streams are unaffected.
 *
 * Extracted from ChatController as free functions over a context bag.
 * `forceEndStalledTurn` routes through `completeTurn` (controllerTurnCompletion.ts)
 * like every other turn-termination path — it used to emit straight to the
 * render stream and bypass the queue-hold policy entirely, so a stalled turn
 * with messages queued behind it left them neither held nor drained nor
 * announced.
 */
import type { Turn, TurnOutcome, TurnTracker } from "./turn";

export interface WatchdogContext {
    turns: TurnTracker;
    completeTurn(turn: Turn, outcome: TurnOutcome): void;
    cancel(): void;
    emit(message: unknown): void;
    /** Minutes of silence before a stalled turn is force-ended (symposium.turnSilenceMinutes);
     *  read fresh on every arm so a live settings change applies to the next turn. <= 0 disables it. */
    silenceMinutes(): number;
    /** Optional longer window for an explicit retry of a stalled turn. */
    retrySilenceMinutes?(): number;
}

export interface WatchdogState {
    timer: ReturnType<typeof setTimeout> | undefined;
    /** Invalidates callbacks that were already queued when a timer was reset. */
    generation?: number;
    /** Test seams; production uses the platform timer functions. */
    schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Selects the deadline for the live turn. A retry is a deliberate recovery
 * attempt, so it gets its own deadline instead of deterministically repeating
 * the same five-minute failure that caused the retry. */
export function watchdogTimeoutMinutes(ctx: WatchdogContext): number {
    const normal = ctx.silenceMinutes();
    if (ctx.turns.current?.origin !== "retry") {
        return normal;
    }
    const retry = ctx.retrySilenceMinutes?.();
    return retry === undefined ? normal : retry;
}

/** (Re)arms the silence watchdog; no-op when idle or when disabled (silenceMinutes <= 0). */
export function armWatchdog(ctx: WatchdogContext, state: WatchdogState): void {
    const generation = invalidateWatchdog(state);
    if (!ctx.turns.isBusy) {
        return;
    }
    const minutes = watchdogTimeoutMinutes(ctx);
    if (minutes <= 0) {
        return;
    }
    const schedule = state.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    state.timer = schedule(
        () => {
            // clearTimeout cannot prevent a callback that has already entered the
            // event loop. A generation check prevents an old deadline from ending
            // a newer retry turn.
            if (state.generation !== generation) {
                return;
            }
            forceEndStalledTurn(ctx, state, minutes);
        },
        minutes * 60 * 1000,
    );
}

function invalidateWatchdog(state: WatchdogState): number {
    if (state.timer !== undefined) {
        (state.cancel ?? clearTimeout)(state.timer);
    }
    state.timer = undefined;
    state.generation = (state.generation ?? 0) + 1;
    return state.generation;
}

export function clearWatchdog(state: WatchdogState): void {
    invalidateWatchdog(state);
}

/** Recovers a turn that produced no events for `minutes` minutes. Marks it
 *  failed (not just cancelled) so `completeTurn` holds any queued message
 *  instead of draining it — a forced stall is a failure, not a normal
 *  continuation point; the user chooses Retry or explicitly promotes/steers
 *  the queue instead of it silently auto-firing next. */
export function forceEndStalledTurn(
    ctx: WatchdogContext,
    state: WatchdogState,
    minutes: number,
): void {
    const turn = ctx.turns.current;
    if (!turn) {
        return;
    }
    clearWatchdog(state);
    ctx.cancel();
    ctx.emit({
        type: "event",
        event: {
            kind: "error",
            message: `Turn ended automatically: no activity from the agent for ${minutes} minute${minutes === 1 ? "" : "s"} (likely a stalled tool or dropped connection).`,
            retryable: true,
        },
    });
    ctx.completeTurn(turn, "failed");
}
