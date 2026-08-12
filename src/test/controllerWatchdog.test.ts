import test from "node:test";
import assert from "node:assert/strict";
import {
    armWatchdog,
    forceEndStalledTurn,
    watchdogTimeoutMinutes,
    type WatchdogContext,
    type WatchdogState,
} from "../application/controllerWatchdog";
import { completeTurn, type TurnCompletionContext } from "../application/controllerTurnCompletion";
import { turnOriginOf } from "../application/controllerTurnRunner";
import { TurnTracker, type TurnOrigin } from "../application/turn";

function stalledContext(queuedCount = 0, origin: TurnOrigin = "user") {
    const turns = new TurnTracker();
    turns.begin(origin);
    const calls: string[] = [];
    const emitted: unknown[] = [];
    let queued = queuedCount;
    const completionCtx: TurnCompletionContext = {
        turns,
        clearWatchdog: () => calls.push("clearWatchdog"),
        statusChanged: () => calls.push("status"),
        emit: (message) => {
            emitted.push(message);
            calls.push("emit");
        },
        takeQueued: () => undefined,
        emitQueue: () => calls.push("emitQueue"),
        dispatch: () => calls.push("dispatch"),
        holdQueue: () => calls.push("holdQueue"),
        queuedCount: () => queued,
    };
    const ctx: WatchdogContext = {
        turns,
        completeTurn: (turn, outcome) => {
            calls.push("cancel-completed");
            completeTurn(turn, completionCtx, { outcome, emitTurnEnd: true });
        },
        cancel: () => calls.push("cancel"),
        emit: (message) => {
            emitted.push(message);
            calls.push("emit");
        },
        silenceMinutes: () => 5,
    };
    return { ctx, turns, calls, emitted, setQueued: (n: number) => (queued = n) };
}

test("stalled turn is canceled, marked failed and exposed as retryable", () => {
    const testContext = stalledContext(1);
    const timer = setTimeout(() => undefined, 60_000);
    const state = { timer: timer as ReturnType<typeof setTimeout> | undefined };

    forceEndStalledTurn(testContext.ctx, state, 5);

    assert.equal(testContext.turns.isBusy, false);
    assert.equal(testContext.turns.lastTurn?.outcome, "failed");
    assert.equal(testContext.turns.lastTurn?.holdsQueue, true);
    assert.equal(state.timer, undefined);
    assert.equal(testContext.calls.includes("cancel"), true);
    // First emit is the retryable error, second is the adapter-shaped turn-end.
    const errorEvent = testContext.emitted[0] as { event: { kind: string; retryable?: boolean } };
    assert.equal(errorEvent.event.kind, "error");
    assert.equal(errorEvent.event.retryable, true);
    const turnEndEvent = testContext.emitted[1] as { event: { kind: string } };
    assert.equal(turnEndEvent.event.kind, "turn-end");
    // With 1 message queued and the turn marked failed, completeTurn holds
    // the queue and announces it — this is the watchdog-bypass bug this
    // refactor closes (a stalled turn used to leave the queue un-held).
    assert.equal(testContext.calls.includes("holdQueue"), true);
    const notice = testContext.emitted.at(-1) as { event: { kind: string; severity?: string } };
    assert.equal(notice.event.kind, "status-notice");
    assert.equal(notice.event.severity, "warning");
});

test("a stale watchdog callback cannot end an already idle turn", () => {
    const testContext = stalledContext();
    const turn = testContext.turns.current;
    if (turn) testContext.turns.end(turn);
    testContext.calls.length = 0;
    testContext.emitted.length = 0;
    const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined };

    forceEndStalledTurn(testContext.ctx, state, 5);

    assert.deepEqual(testContext.calls, []);
    assert.deepEqual(testContext.emitted, []);
});

test("an explicit retry gets its own silence deadline", () => {
    const testContext = stalledContext(0, "retry");
    testContext.ctx.retrySilenceMinutes = () => 15;

    assert.equal(watchdogTimeoutMinutes(testContext.ctx), 15);
});

test("rearming invalidates a deadline callback from the previous attempt", () => {
    const testContext = stalledContext();
    const callbacks: Array<() => void> = [];
    const state: WatchdogState = {
        timer: undefined,
        schedule: (callback) => {
            callbacks.push(callback);
            return callbacks.length as unknown as ReturnType<typeof setTimeout>;
        },
        cancel: () => undefined,
    };

    armWatchdog(testContext.ctx, state);
    armWatchdog(testContext.ctx, state);

    callbacks[0]();
    assert.equal(testContext.turns.isBusy, true);
    callbacks[1]();
    assert.equal(testContext.turns.isBusy, false);
});

test("a retry marker survives when the original turn id is unavailable", () => {
    assert.equal(turnOriginOf({ retryOf: undefined, interruptedBy: "stalled" }), "retry");
});
