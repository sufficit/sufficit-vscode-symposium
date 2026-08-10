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
    options?: { outcome?: TurnOutcome; emitTurnEnd?: boolean },
): void {
    const changed = ctx.turns.end(turn, options?.outcome);
    if (!changed) {
        ctx.log?.(`[turn] completeTurn no-op — already ended: ${turn.describe()}`);
        return;
    }
    ctx.clearWatchdog();
    if (options?.emitTurnEnd) {
        ctx.emit({
            type: "event",
            event: {
                kind: "turn-end",
                durationMs: turn.durationMs,
                ...(turn.backendId ? { logicalTurnId: turn.backendId } : {}),
            },
        });
    }
    ctx.statusChanged();
    if (turn.holdsQueue) {
        const heldCount = ctx.queuedCount();
        ctx.log?.(`[turn] ${turn.describe()} — holding ${heldCount} queued message(s)`);
        if (heldCount > 0) {
            ctx.holdQueue({ reason: "turn-failed", turnId: turn.backendId ?? turn.id, at: Date.now() });
            ctx.emitQueue();
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
        return;
    }
    const next = ctx.takeQueued();
    if (next) {
        ctx.log?.(
            `[turn] ${turn.describe()} — draining queue, dispatching next (${ctx.queuedCount()} left after)`,
        );
        ctx.emitQueue();
        ctx.dispatch(next);
    } else {
        ctx.log?.(`[turn] ${turn.describe()} — complete, queue empty`);
    }
}
