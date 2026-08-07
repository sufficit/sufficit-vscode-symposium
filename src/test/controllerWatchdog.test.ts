import test from "node:test";
import assert from "node:assert/strict";
import { forceEndStalledTurn, type WatchdogContext } from "../application/controllerWatchdog";

function stalledContext() {
    let busy = true;
    let failed = false;
    const calls: string[] = [];
    const emitted: unknown[] = [];
    const ctx: WatchdogContext = {
        busy: () => busy,
        setBusy: (value) => {
            busy = value;
            calls.push(`busy:${value}`);
        },
        markTurnFailed: () => {
            failed = true;
            calls.push("failed");
        },
        cancel: () => {
            calls.push("cancel");
        },
        onStatusChange: () => {
            calls.push("status");
        },
        emit: (message) => {
            emitted.push(message);
            calls.push("emit");
        },
        silenceMinutes: () => 5,
    };
    return { ctx, calls, emitted, busy: () => busy, failed: () => failed };
}

test("stalled turn is canceled, marked failed and exposed as retryable", () => {
    const testContext = stalledContext();
    const timer = setTimeout(() => undefined, 60_000);
    const state = { timer: timer as ReturnType<typeof setTimeout> | undefined };

    forceEndStalledTurn(testContext.ctx, state, 5);

    assert.equal(testContext.busy(), false);
    assert.equal(testContext.failed(), true);
    assert.equal(state.timer, undefined);
    assert.deepEqual(testContext.calls, [
        "busy:false",
        "failed",
        "cancel",
        "status",
        "emit",
        "emit",
    ]);
    assert.deepEqual(testContext.emitted, [
        {
            type: "event",
            event: {
                kind: "error",
                message:
                    "Turn ended automatically: no activity from the agent for 5 minutes (likely a stalled tool or dropped connection).",
                retryable: true,
            },
        },
        { type: "event", event: { kind: "turn-end" } },
    ]);
});

test("a stale watchdog callback cannot end an already idle turn", () => {
    const testContext = stalledContext();
    testContext.ctx.setBusy(false);
    testContext.calls.length = 0;
    const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined };

    forceEndStalledTurn(testContext.ctx, state, 5);

    assert.deepEqual(testContext.calls, []);
    assert.deepEqual(testContext.emitted, []);
    assert.equal(testContext.failed(), false);
});
