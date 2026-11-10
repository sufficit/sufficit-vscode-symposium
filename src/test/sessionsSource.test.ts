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
        ready: () => Promise.resolve(cached.slice()),
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

function withTimeout<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(
                () => reject(new Error("timed out waiting for the first list")),
                ms,
            ),
        ),
    ]);
}

test("cold start resolves the first useful list before every backend lands", async () => {
    const resolveBackend: Record<string, (sessions: SessionInfo[]) => void> = {};
    const settled: Record<string, Promise<SessionInfo[]>> = {};
    for (const backend of ["a", "b"]) {
        settled[backend] = new Promise<SessionInfo[]>((resolve) => {
            resolveBackend[backend] = resolve;
        });
    }
    const reconcileCalls: string[] = [];
    const index: SessionsSourceIndex = {
        listCached: () => [],
        reconcile: () => {
            reconcileCalls.push("reconcile");
            // A wrong implementation awaiting this would hang the timeout.
            return Promise.all([settled.a, settled.b]).then(() => []);
        },
        ready: () => settled.a.then(() => [session("a1")]),
    };
    const rawSessions = createSessionsSource(index);

    const first = rawSessions();
    resolveBackend.a([session("a1")]);

    assert.deepEqual(
        (await withTimeout(first)).map((s) => s.sessionId),
        ["a1"],
    );

    // Backend b is still pending; a later list must not block on it either.
    resolveBackend.b([]);
    await flush();
    assert.deepEqual(reconcileCalls, ["reconcile"]);
});

test("cold start falls back to the end-of-scan snapshot when every backend is empty", async () => {
    const index: SessionsSourceIndex = {
        listCached: () => [],
        reconcile: () => Promise.resolve([]),
        ready: () => Promise.resolve([]),
    };
    const rawSessions = createSessionsSource(index);

    assert.deepEqual(await withTimeout(rawSessions()), []);
});

test("a missing index yields an empty session list", async () => {
    const rawSessions = createSessionsSource(undefined);

    assert.deepEqual(await rawSessions(), []);
});
