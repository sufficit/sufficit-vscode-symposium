/**
 * The one place a turn can end. Before this existed there were three
 * independent termination paths — the adapter turn-end reducer
 * (controllerEventHandler.ts), the silence watchdog (controllerWatchdog.ts),
 * and a dispatch that threw before the backend ever ran
 * (controllerDispatch.ts) — and only the first applied the queue-hold
 * policy. A turn force-ended by the watchdog bypassed the reducer entirely
 * (it emitted straight to the render stream), so a stall left queued
 * messages neither held nor drained nor announced — the exact bug this
 * refactor exists to close.
 */
import type { PendingMessage } from "./controllerQueue";
import type { QueueHold } from "./controllerQueue";
import type { Turn, TurnOutcome, TurnTracker } from "./turn";
import type { AgentEvent } from "../adapters/types";

type TurnEndEvent = Extract<AgentEvent, { kind: "turn-end" }>;

export interface TurnCompletionContext {
    turns: TurnTracker;
    clearWatchdog(): void;
    statusChanged(): void;
    emit(message: unknown): void;
    takeQueued(): PendingMessage | undefined;
    emitQueue(): void;
    dispatch(message: PendingMessage): void;
    holdQueue(hold: QueueHold): void;
    queuedCount(): number;
    releaseOwnership(): void;
    /** Returns true when bounded recovery owns the next action for this failure. */
    recoverFailedTurn?(turn: Turn): boolean;
    log?(message: string): void;
}

/**
 * Terminates `turn` and applies its queue policy. `emitTurnEnd` is false only
 * for the adapter-event reducer, which has already emitted the adapter's own
 * turn-end event — every other caller (watchdog, dispatch-catch) needs this
 * to emit one, since nothing else will.
 */
export function completeTurn(
    turn: Turn,
    ctx: TurnCompletionContext,
    options?: { outcome?: TurnOutcome; emitTurnEnd?: boolean; turnEndEvent?: TurnEndEvent },
): void {
    const changed = ctx.turns.end(turn, options?.outcome);
    if (!changed) {
        ctx.log?.(`[turn] completeTurn no-op — already ended: ${turn.describe()}`);
        return;
    }
    ctx.clearWatchdog();
    // Recovery owns a retryable raw error only until it has either scheduled
    // another attempt or put that error back into the render stream. This must
    // happen before turn-end: AHP intentionally resets its active turn at the
    // terminal boundary and cannot associate a late error card afterwards.
    const recoveryScheduled = ctx.recoverFailedTurn?.(turn) ?? false;
    if (turn.outcome === "failed" && !recoveryScheduled) {
        const hiddenError = turn.takeError();
        if (hiddenError) {
            ctx.log?.(`[turn] exposing deferred terminal error fallback for ${turn.describe()}`);
            ctx.emit({ type: "event", event: hiddenError });
        }
    }
    if (options?.emitTurnEnd) {
        ctx.emit({
            type: "event",
            event:
                options.turnEndEvent ??
                ({
                    kind: "turn-end",
                    durationMs: turn.durationMs,
                    ...(turn.backendId ? { logicalTurnId: turn.backendId } : {}),
                } satisfies TurnEndEvent),
        });
    }
    if (turn.outcome === "failed" && recoveryScheduled) {
        ctx.statusChanged();
        // Keep queued work behind the automatic retry and publish the pending
        // state without turning it into a misleading "held after error" row.
        ctx.emitQueue();
        return;
    }
    ctx.statusChanged();
    if (turn.holdsQueue) {
        const heldCount = ctx.queuedCount();
        ctx.log?.(`[turn] ${turn.describe()} — holding ${heldCount} queued message(s)`);
        if (heldCount > 0) {
            ctx.holdQueue({
                reason: "turn-failed",
                turnId: turn.backendId ?? turn.id,
                at: Date.now(),
            });
            ctx.emit({
                type: "event",
                event: {
                    kind: "status-notice",
                    severity: "warning",
                    terminal: true,
                    text:
                        heldCount === 1
                            ? "1 queued message held — the turn before it failed. Send now or discard it from the Queued panel."
                            : `${heldCount} queued messages held — the turn before them failed. Send now or discard them from the Queued panel.`,
                },
            });
        }
        // Reconcile the client's queue display with server truth every time,
        // not just when there's something to hold — otherwise a client whose
        // display went stale for any other reason (a reload racing a seed,
        // a missed broadcast) never gets corrected, because nothing else
        // tells it "the queue is actually empty" on a heldCount === 0 turn.
        ctx.emitQueue();
        ctx.releaseOwnership();
        return;
    }
    const next = ctx.takeQueued();
    if (next) {
        ctx.log?.(
            `[turn] ${turn.describe()} — draining queue, dispatching next (${ctx.queuedCount()} left after)`,
        );
    } else {
        ctx.log?.(`[turn] ${turn.describe()} — complete, queue empty`);
    }
    // Same reconciliation as above: always broadcast current queue state,
    // even when there's nothing to drain.
    ctx.emitQueue();
    if (next) {
        ctx.dispatch(next);
    } else {
        ctx.releaseOwnership();
    }
}
