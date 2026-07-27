import assert from "node:assert/strict";
import test from "node:test";
import type {
    ActionOrigin,
    RootActiveSessionsChangedAction,
    RootState,
    StateAction,
} from "@microsoft/agent-host-protocol";
import { AhpStateStore } from "../ahp/channelStore";

const ROOT = "ahp-root://";
const SESSION = "ahp-session:/session-1";

function activeSessions(value: number): RootActiveSessionsChangedAction {
    return { type: "root/activeSessionsChanged", activeSessions: value } as RootActiveSessionsChangedAction;
}

function rootStore(replayCapacity = 10): AhpStateStore {
    const store = new AhpStateStore({ replayCapacity });
    store.register<RootState, RootActiveSessionsChangedAction>(
        ROOT,
        { agents: [], activeSessions: 0 },
        (state, action) => ({ ...state, activeSessions: action.activeSessions }),
    );
    return store;
}

test("AHP state store sequences, reduces and fans out accepted actions", () => {
    const store = rootStore();
    const seen: number[] = [];
    const unsubscribe = store.subscribe(ROOT, (envelope) => seen.push(envelope.serverSeq));

    const first = store.dispatch(ROOT, activeSessions(1) as StateAction);
    const second = store.dispatch(ROOT, activeSessions(2) as StateAction);

    assert.equal(first.serverSeq, 1);
    assert.equal(second.serverSeq, 2);
    assert.deepEqual(seen, [1, 2]);
    assert.equal((store.snapshot(ROOT).state as RootState).activeSessions, 2);
    assert.equal(store.snapshot(ROOT).fromSeq, 2);

    unsubscribe();
    store.dispatch(ROOT, activeSessions(3) as StateAction);
    assert.deepEqual(seen, [1, 2]);
});

test("AHP subscriber failures are isolated from other connected clients", () => {
    const failures: unknown[] = [];
    const store = new AhpStateStore({
        onListenerError: (error) => failures.push(error),
    });
    store.register<RootState, RootActiveSessionsChangedAction>(
        ROOT,
        { agents: [], activeSessions: 0 },
        (state, action) => ({ ...state, activeSessions: action.activeSessions }),
    );
    const seen: number[] = [];
    store.subscribe(ROOT, () => {
        throw new Error("disconnected client");
    });
    store.subscribe(ROOT, (envelope) => seen.push(envelope.serverSeq));

    store.dispatch(ROOT, activeSessions(1) as StateAction);

    assert.equal(failures.length, 1);
    assert.deepEqual(seen, [1]);
});

test("AHP rejected client action is sequenced and echoed without changing state", () => {
    const store = rootStore();
    const origin: ActionOrigin = { clientId: "web", clientSeq: 7 };
    const envelope = store.dispatch(ROOT, activeSessions(99) as StateAction, {
        origin,
        rejectionReason: "server-owned action",
    });

    assert.deepEqual(envelope.origin, origin);
    assert.equal(envelope.rejectionReason, "server-owned action");
    assert.equal((store.snapshot(ROOT).state as RootState).activeSessions, 0);
});

test("AHP reconnect replays retained subscribed actions and reports missing channels", () => {
    const store = rootStore();
    store.dispatch(ROOT, activeSessions(1) as StateAction);
    store.dispatch(ROOT, activeSessions(2) as StateAction);

    const result = store.reconnect(1, [ROOT, SESSION]);

    assert.equal(result.type, "replay");
    if (result.type === "replay") {
        assert.deepEqual(result.actions.map((item) => item.serverSeq), [2]);
        assert.deepEqual(result.missing, [SESSION]);
    }
});

test("AHP reconnect falls back to a snapshot after replay history rolls over", () => {
    const store = rootStore(1);
    store.dispatch(ROOT, activeSessions(1) as StateAction);
    store.dispatch(ROOT, activeSessions(2) as StateAction);

    const result = store.reconnect(0, [ROOT]);

    assert.equal(result.type, "snapshot");
    if (result.type === "snapshot") {
        assert.equal(result.snapshots.length, 1);
        assert.equal(result.snapshots[0].fromSeq, 2);
        assert.equal((result.snapshots[0].state as RootState).activeSessions, 2);
    }
});

test("AHP channel registration and sequence inputs are guarded", () => {
    const store = rootStore();

    assert.throws(() => store.register(ROOT, { agents: [] }, (state) => state), /already registered/);
    assert.throws(() => store.snapshot(SESSION), /Unknown AHP channel/);
    assert.throws(() => store.reconnect(-1, [ROOT]), /lastSeenServerSeq/);
    assert.throws(() => new AhpStateStore({ replayCapacity: -1 }), /replayCapacity/);
});
