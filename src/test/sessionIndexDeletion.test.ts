import test from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter, SessionInfo } from "../adapters/types";
import { SessionIndex } from "../sessions/index";
import { InMemorySessionRepository } from "../sessions/memoryRepository";

function stored(info: SessionInfo) {
    return { ...info, updatedAt: info.updatedAt?.getTime() };
}

test("forget removes a deleted session immediately from cache and repository", async () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "deleted",
        title: "Original title",
        updatedAt: new Date(1000),
    };
    const repository = new InMemorySessionRepository();
    repository.replaceAll([stored(info)]);
    const index = new SessionIndex({ storageDir: "/unused", adapters: [], repository });

    await index.forget(info.backend, info.sessionId);

    assert.equal(index.get(info.backend, info.sessionId), undefined);
    assert.deepEqual(repository.list(), []);
});

test("forget invalidates an in-flight scan so it cannot resurrect the deleted session", async () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "deleted",
        title: "Original title",
        updatedAt: new Date(1000),
    };
    const repository = new InMemorySessionRepository();
    repository.replaceAll([stored(info)]);
    let releaseScan!: (sessions: SessionInfo[]) => void;
    let markStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const scanResult = new Promise<SessionInfo[]>((resolve) => {
        releaseScan = resolve;
    });
    const adapter = {
        backend: "claude",
        listSessions: () => scanResult,
        listSessionsIncremental: () => {
            markStarted();
            return scanResult;
        },
    } as unknown as AgentAdapter;
    const index = new SessionIndex({ storageDir: "/unused", adapters: [adapter], repository });

    const reconcile = index.reconcile();
    await scanStarted;
    await index.forget(info.backend, info.sessionId);
    releaseScan([info]);
    await reconcile;

    assert.equal(index.get(info.backend, info.sessionId), undefined);
    assert.deepEqual(repository.list(), []);
});

test("a scan invalidated while persistence is pending does not repopulate the cache", async () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "late",
        title: "Late",
        updatedAt: new Date(1000),
    };
    let release!: () => void;
    let markWriting!: () => void;
    const writing = new Promise<void>((resolve) => (markWriting = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    class SlowRepository extends InMemorySessionRepository {
        override async replaceProvider(
            backend: string,
            sessions: Parameters<InMemorySessionRepository["replaceProvider"]>[1],
        ): Promise<void> {
            await super.replaceProvider(backend, sessions);
            markWriting();
            await gate;
        }
    }
    const adapter = {
        backend: "claude",
        listSessions: () => Promise.resolve([info]),
    } as unknown as AgentAdapter;
    const repository = new SlowRepository();
    const index = new SessionIndex({
        storageDir: "/unused",
        adapters: [adapter],
        repository,
    });
    const reconcile = index.reconcile();
    await writing;
    const forgetting = index.forget(info.backend, info.sessionId);
    release();
    await Promise.all([reconcile, forgetting]);
    assert.equal(index.get(info.backend, info.sessionId), undefined);
    assert.deepEqual(repository.list(), []);
});

test("reconcile does not wait for a slow repository write and keeps the catalog correct", async () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "fresh",
        title: "Fresh",
        updatedAt: new Date(1000),
    };
    let writeStarted = false;
    class HangingRepository extends InMemorySessionRepository {
        override replaceProvider(
            backend: string,
            sessions: Parameters<InMemorySessionRepository["replaceProvider"]>[1],
        ): Promise<void> {
            void super.replaceProvider(backend, sessions);
            writeStarted = true;
            return new Promise<void>(() => undefined); // a disk that never answers
        }
    }
    const adapter = {
        backend: "claude",
        listSessions: () => Promise.resolve([info]),
    } as unknown as AgentAdapter;
    const index = new SessionIndex({
        storageDir: "/unused",
        adapters: [adapter],
        repository: new HangingRepository(),
    });

    const sessions = await index.reconcile();

    assert.equal(writeStarted, true);
    assert.deepEqual(
        sessions.map((item) => item.sessionId),
        ["fresh"],
    );
    assert.equal(index.get("claude", "fresh")?.title, "Fresh");
});

test("a failing repository write is logged and never fails the reconcile", async () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "x",
        title: "X",
        updatedAt: new Date(1),
    };
    class FailingRepository extends InMemorySessionRepository {
        override replaceProvider(): Promise<void> {
            return Promise.reject(new Error("disk full"));
        }
    }
    const logs: string[] = [];
    const adapter = {
        backend: "claude",
        listSessions: () => Promise.resolve([info]),
    } as unknown as AgentAdapter;
    const index = new SessionIndex({
        storageDir: "/unused",
        adapters: [adapter],
        repository: new FailingRepository(),
        log: (message) => logs.push(message),
    });

    const sessions = await index.reconcile();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sessions.length, 1);
    assert.ok(logs.some((line) => line.includes("claude persistence failed: disk full")));
});

test("forget flushes the repository so a deletion is durable immediately", async () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "gone",
        title: "Gone",
        updatedAt: new Date(1),
    };
    let flushed = 0;
    class DebouncedRepository extends InMemorySessionRepository {
        flush(): Promise<void> {
            flushed++;
            return Promise.resolve();
        }
    }
    const repository = new DebouncedRepository();
    repository.replaceAll([stored(info)]);
    const index = new SessionIndex({ storageDir: "/unused", adapters: [], repository });

    await index.forget("claude", "gone");

    assert.equal(flushed, 1);
});
