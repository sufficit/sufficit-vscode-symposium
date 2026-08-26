import assert from "node:assert/strict";
import test from "node:test";
import { PeerRenderState } from "../application/peerRenderState";

const peer = { id: "peer", pid: 42 };

test("peer render state restores only a live unmatched turn", () => {
    const state = new PeerRenderState((writer) => writer?.pid === 42);
    const start = event("turn-start", { logicalTurnId: "turn-1" });

    assert.deepEqual(state.restore([{ message: start, writer: peer }], "local"), start);
    assert.equal(state.busy, true);
    assert.equal(state.attention, undefined);

    state.observe({ message: event("turn-end", { logicalTurnId: "turn-1" }), writer: peer });
    assert.equal(state.busy, false);
});

test("peer render state does not resurrect a dead or completed historical turn", () => {
    const dead = new PeerRenderState(() => false);
    assert.equal(
        dead.restore([{ message: event("turn-start"), writer: peer }], "local"),
        undefined,
    );
    assert.equal(dead.busy, false);

    const complete = new PeerRenderState(() => true);
    assert.equal(
        complete.restore(
            [
                { message: event("turn-start"), writer: peer },
                { message: event("turn-end"), writer: peer },
            ],
            "local",
        ),
        undefined,
    );
    assert.equal(complete.busy, false);
});

test("peer render state carries a terminal failure only after the turn stops", () => {
    const state = new PeerRenderState(() => true);
    state.observe({ message: event("turn-start"), writer: peer });
    state.observe({ message: event("error", { fatal: true }), writer: peer });
    assert.equal(state.busy, true);
    assert.equal(state.attention, undefined);

    state.observe({ message: event("turn-end"), writer: peer });
    assert.equal(state.busy, false);
    assert.equal(state.attention, "error");
});

test("a live peer disappearing mid-turn becomes an error instead of false idle", () => {
    let alive = true;
    const state = new PeerRenderState(() => alive);
    state.observe({ message: event("turn-start", { logicalTurnId: "turn-1" }), writer: peer });

    alive = false;
    assert.equal(state.refreshLiveness(), true);
    assert.equal(state.busy, false);
    assert.equal(state.attention, "error");
    assert.deepEqual(state.takeAbandonedTurn(), { logicalTurnId: "turn-1" });
    assert.equal(state.takeAbandonedTurn(), undefined);
});

function event(kind: string, extra: Record<string, unknown> = {}): unknown {
    return { type: "event", event: { kind, ...extra } };
}
