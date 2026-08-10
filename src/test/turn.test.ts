import assert from "node:assert/strict";
import test from "node:test";
import { Turn, TurnTracker } from "../application/turn";

test("Turn.end derives outcome: error wins over cancel", () => {
    const turn = new Turn({ id: "t1", origin: "user", startedAt: 0 });
    turn.recordError();
    turn.requestCancel();
    assert.equal(turn.end(), true);
    assert.equal(turn.outcome, "failed");
    assert.equal(turn.holdsQueue, true);
});

test("Turn.end derives outcome: clean cancel drains (no error)", () => {
    const turn = new Turn({ id: "t1", origin: "user", startedAt: 0 });
    turn.requestCancel();
    turn.end();
    assert.equal(turn.outcome, "cancelled");
    assert.equal(turn.holdsQueue, false);
});

test("Turn.end derives outcome: plain success", () => {
    const turn = new Turn({ id: "t1", origin: "user", startedAt: 0 });
    turn.end();
    assert.equal(turn.outcome, "completed");
    assert.equal(turn.holdsQueue, false);
});

test("Turn.end is idempotent", () => {
    const turn = new Turn({ id: "t1", origin: "user", startedAt: 0 });
    assert.equal(turn.end(undefined, 10), true);
    assert.equal(turn.end(undefined, 20), false);
    assert.equal(turn.durationMs, 10);
});

test("Turn.recordError after end only changes the badge, never holdsQueue retroactively", () => {
    const turn = new Turn({ id: "t1", origin: "user", startedAt: 0 });
    turn.end(); // completed, holdsQueue false
    turn.recordError();
    assert.equal(turn.attention, "error");
    assert.equal(turn.holdsQueue, false);
});

test("TurnTracker.isBusy / attention reflect the live vs last turn", () => {
    const tracker = new TurnTracker();
    assert.equal(tracker.isBusy, false);
    assert.equal(tracker.attention, undefined);
    const turn = tracker.begin("user");
    assert.equal(tracker.isBusy, true);
    assert.equal(tracker.attention, undefined); // no attention while live
    turn.recordError();
    assert.equal(tracker.attention, undefined); // still live — badge hidden
    tracker.end(turn);
    assert.equal(tracker.isBusy, false);
    assert.equal(tracker.attention, "error"); // now surfaced from lastTurn
});

test("TurnTracker.resolveEnd: no live turn is rejected", () => {
    const tracker = new TurnTracker();
    const decision = tracker.resolveEnd(undefined);
    assert.equal(decision.accept, false);
    assert.equal((decision as { reason: string }).reason, "no-live-turn");
});

test("TurnTracker.resolveEnd: duplicate end for the same turn is rejected (codex double turn-end)", () => {
    const tracker = new TurnTracker();
    const turn = tracker.begin("user");
    const first = tracker.resolveEnd(undefined);
    assert.equal(first.accept, true);
    tracker.end((first as { turn: Turn }).turn);
    const second = tracker.resolveEnd(undefined);
    assert.equal(second.accept, false);
    assert.equal((second as { reason: string }).reason, "no-live-turn");
    assert.equal(turn.outcome, "completed");
});

test("TurnTracker.resolveEnd: a straggler from a superseded turn is rejected by id", () => {
    const tracker = new TurnTracker();
    const first = tracker.begin("user");
    tracker.resolveStart("backend-1");
    tracker.end(first); // ends and retires "backend-1"
    tracker.begin("user"); // a new turn is now live, unbound
    const straggler = tracker.resolveEnd("backend-1");
    assert.equal(straggler.accept, false);
    assert.equal((straggler as { reason: string }).reason, "stale-id");
});

test("TurnTracker.resolveEnd: unbound live turn binds the id on accept", () => {
    const tracker = new TurnTracker();
    const turn = tracker.begin("user");
    const decision = tracker.resolveEnd("backend-9");
    assert.equal(decision.accept, true);
    assert.equal(turn.backendId, "backend-9");
});

test("TurnTracker.resolveEnd: mismatched id against a bound live turn is rejected", () => {
    const tracker = new TurnTracker();
    const turn = tracker.begin("user");
    turn.bindBackendId("backend-1");
    const decision = tracker.resolveEnd("backend-2");
    assert.equal(decision.accept, false);
    assert.equal((decision as { reason: string }).reason, "stale-id");
});

test("TurnTracker: Retry un-retires its expectedBackendId so the retried turn's end is accepted", () => {
    const tracker = new TurnTracker();
    const failed = tracker.begin("user");
    tracker.resolveStart("backend-1");
    tracker.end(failed, "failed"); // retires "backend-1"

    // Without un-retiring, resolving the retry's end for the SAME backend id
    // (the adapter deliberately reuses it) would be rejected as stale.
    const retry = tracker.begin("retry", { expectedBackendId: "backend-1" });
    tracker.resolveStart("backend-1");
    assert.equal(retry.backendId, "backend-1");
    const decision = tracker.resolveEnd("backend-1");
    assert.equal(decision.accept, true);
});

test("TurnTracker.begin supersedes a still-live turn instead of allowing two live turns", () => {
    const tracker = new TurnTracker();
    const first = tracker.begin("user");
    const second = tracker.begin("user");
    assert.equal(first.outcome, "superseded");
    assert.equal(tracker.current, second);
});

test("TurnTracker.resolveStart: retired id is rejected, live unbound turn rebinds on mismatch", () => {
    const tracker = new TurnTracker();
    const first = tracker.begin("user");
    tracker.resolveStart("backend-1");
    tracker.end(first);
    tracker.begin("user");
    const stale = tracker.resolveStart("backend-1");
    assert.equal(stale.accept, false);

    const tracker2 = new TurnTracker();
    const turn = tracker2.begin("user");
    turn.bindBackendId("backend-a");
    const rebind = tracker2.resolveStart("backend-b");
    assert.equal(rebind.accept, true);
    assert.equal(turn.backendId, "backend-b");
});
