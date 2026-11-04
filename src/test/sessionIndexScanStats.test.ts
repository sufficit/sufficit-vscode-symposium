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

test("reconcile logs snapshot load, per-backend discovery timing and read counters", async () => {
    const logs: string[] = [];
    const slow: SessionInfo = info("claude", "slow");
    let calls = 0;
    const adapter = {
        backend: "claude",
        listSessions: () => {
            calls++;
            return new Promise<SessionInfo[]>((resolve) =>
                setTimeout(() => resolve([slow]), 20),
            );
        },
    } as unknown as AgentAdapter;
    const repository = new InMemorySessionRepository();
    repository.replaceAll([{ ...slow, updatedAt: slow.updatedAt?.getTime() }]);
    const index = new SessionIndex({
        storageDir: "/unused",
        adapters: [adapter],
        repository,
        log: (message) => logs.push(message),
    });

    await index.reconcile();

    assert.ok(
        logs.some((line) => /index snapshot loaded \d+ sessions in \d+ ms/.test(line)),
        `missing snapshot-load timing: ${logs.join(" | ")}`,
    );
    assert.ok(
        logs.some((line) => /claude discovery \d+ ms, 1 sessions/.test(line)),
        `missing per-backend timing: ${logs.join(" | ")}`,
    );
    assert.ok(
        logs.some((line) =>
            /reconciled 1 sessions in \d+ ms \([^)]*reads=\d+ bytes=\d+ cache hits=\d+ misses=\d+ joined=\d+/.test(
                line,
            )),
        `missing read counters: ${logs.join(" | ")}`,
    );
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

    assert.equal(calls, 1, "concurrent callers must share one backend scan");
    assert.ok(
        logs.some((line) => line.includes("reconcile joined an in-flight scan")),
        `missing join log: ${logs.join(" | ")}`,
    );
    for (const list of results) {
        assert.deepEqual(
            list.map((s) => s.sessionId),
            ["target"],
        );
    }
});
