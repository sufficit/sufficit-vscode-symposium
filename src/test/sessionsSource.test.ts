import test from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "../adapters/types";
import { createSessionsSource, SessionsSourceIndex } from "../extension/sessionsSource";

const session = (id: string): SessionInfo => ({
    backend: "claude",
    sessionId: id,
    title: `Session ${id}`,
    updatedAt: new Date(1000),
});

function makeRecorder() {
    const cached: SessionInfo[] = [];
    let reconcileCalls = 0;
    const index: SessionsSourceIndex = {
        listCached: () => cached.slice(),
        reconcile: () => {
            reconcileCalls += 1;
            cached.push(session(`s${reconcileCalls}`));
            return Promise.resolve(cached.slice());
        },
    };
    return { index, cached, reconcileCalls: () => reconcileCalls };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("cold index primes once, then serves the cached snapshot without rescanning", async () => {
    const recorder = makeRecorder();
    const rawSessions = createSessionsSource(recorder.index);

    const first = await rawSessions();

    assert.deepEqual(
        first.map((s) => s.sessionId),
        ["s1"],
    );
    assert.deepEqual(
        recorder.cached.map((s) => s.sessionId),
        ["s1"],
    );

    const second = await rawSessions();

    assert.equal(recorder.reconcileCalls(), 1);
    assert.deepEqual(
        second.map((s) => s.sessionId),
        ["s1"],
    );
});

test("warm index returns the cache immediately and throttles background reconciles", async () => {
    const recorder = makeRecorder();
    recorder.cached.push(session("warm-1"));
    const rawSessions = createSessionsSource(recorder.index);

    const first = await rawSessions();

    assert.deepEqual(
        first.map((s) => s.sessionId),
        ["warm-1"],
    );
    await flush();
    assert.equal(recorder.reconcileCalls(), 1);

    await rawSessions();

    assert.equal(recorder.reconcileCalls(), 1);
});

test("a missing index yields an empty session list", async () => {
    const rawSessions = createSessionsSource(undefined);

    assert.deepEqual(await rawSessions(), []);
});
