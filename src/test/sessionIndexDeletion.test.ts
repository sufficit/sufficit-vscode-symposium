import test from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter, SessionInfo } from "../adapters/types";
import { SessionIndex } from "../sessions/index";
import { InMemorySessionRepository } from "../sessions/memoryRepository";

function stored(info: SessionInfo) {
    return { ...info, updatedAt: info.updatedAt?.getTime() };
}

test("forget removes a deleted session immediately from cache and repository", () => {
    const info: SessionInfo = {
        backend: "claude", sessionId: "deleted", title: "Original title", updatedAt: new Date(1000),
    };
    const repository = new InMemorySessionRepository();
    repository.replaceAll([stored(info)]);
    const index = new SessionIndex({ storageDir: "/unused", adapters: [], repository });

    index.forget(info.backend, info.sessionId);

    assert.equal(index.get(info.backend, info.sessionId), undefined);
    assert.deepEqual(repository.list(), []);
});

test("forget invalidates an in-flight scan so it cannot resurrect the deleted session", async () => {
    const info: SessionInfo = {
        backend: "claude", sessionId: "deleted", title: "Original title", updatedAt: new Date(1000),
    };
    const repository = new InMemorySessionRepository();
    repository.replaceAll([stored(info)]);
    let releaseScan!: (sessions: SessionInfo[]) => void;
    let markStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const scanResult = new Promise<SessionInfo[]>((resolve) => { releaseScan = resolve; });
    const adapter = {
        backend: "claude",
        listSessions: () => scanResult,
        listSessionsIncremental: () => { markStarted(); return scanResult; },
    } as unknown as AgentAdapter;
    const index = new SessionIndex({ storageDir: "/unused", adapters: [adapter], repository });

    const reconcile = index.reconcile();
    await scanStarted;
    index.forget(info.backend, info.sessionId);
    releaseScan([info]);
    await reconcile;

    assert.equal(index.get(info.backend, info.sessionId), undefined);
    assert.deepEqual(repository.list(), []);
});
