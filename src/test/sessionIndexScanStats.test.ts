import test from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter, SessionInfo } from "../adapters/types";
import { SessionIndex } from "../sessions/index";
import { InMemorySessionRepository } from "../sessions/memoryRepository";

function info(backend: string, sessionId: string): SessionInfo {
    return {
        backend,
        sessionId,
        title: `Session ${sessionId}`,
        updatedAt: new Date(1000),
    };
}

test("reconcile logs snapshot load, per-backend timing and read counters", async () => {
    const logs: string[] = [];
    const target = info("claude", "slow");
    let calls = 0;
    const adapter = {
        backend: "claude",
        listSessions: () => {
            calls++;
            return new Promise<SessionInfo[]>((resolve) => {
                setTimeout(() => resolve([target]), 20);
            });
        },
    } as unknown as AgentAdapter;
    const repository = new InMemorySessionRepository();
    repository.replaceAll([{ ...target, updatedAt: 1000 }]);
    const index = new SessionIndex({
        storageDir: "/unused",
        adapters: [adapter],
        repository,
        log: (message) => logs.push(message),
    });

    await index.reconcile();

    const snapshot = logs.find((line) => line.includes("index snapshot loaded")) ?? "";
    assert.match(snapshot, /index snapshot loaded \d+ sessions in \d+ ms/);

    const discovery = logs.find((line) => line.includes("claude discovery")) ?? "";
    assert.match(discovery, /claude discovery \d+ ms, 1 sessions/);

    const summary = logs.find((line) => line.includes("reconciled 1 sessions")) ?? "";
    assert.match(summary, /reads=\d+ bytes=\d+ cache hits=\d+ misses=\d+ joined=\d+/);
    assert.equal(calls, 1);
});

test("concurrent reconcile callers join one scan instead of duplicating it", async () => {
    const logs: string[] = [];
    const target = info("codex", "target");
    let calls = 0;
    let releaseScan!: (sessions: SessionInfo[]) => void;
    let markStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => (markStarted = resolve));
    const scanResult = new Promise<SessionInfo[]>((resolve) => (releaseScan = resolve));
    const adapter = {
        backend: "codex",
        listSessions: () => {
            calls++;
            markStarted();
            return scanResult;
        },
    } as unknown as AgentAdapter;
    const index = new SessionIndex({
        storageDir: "/unused",
        adapters: [adapter],
        repository: new InMemorySessionRepository(),
        log: (message) => logs.push(message),
    });

    const first = index.reconcile();
    const second = index.reconcile();
    const third = index.reconcile();
    await scanStarted;
    releaseScan([target]);
    const results = await Promise.all([first, second, third]);

    assert.equal(calls, 1);
    const joinLog = logs.find((line) => line.includes("joined callers")) ?? "";
    assert.match(joinLog, /joined callers: 2/);
    for (const list of results) {
        assert.deepEqual(
            list.map((s) => s.sessionId),
            ["target"],
        );
    }
});
