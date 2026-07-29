import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AgentAdapter, AgentSession, SessionInfo, SessionStartOptions } from "../adapters/types";
import { SessionIndex } from "../sessions/index";

function adapter(backend: string, list: () => Promise<SessionInfo[]>): AgentAdapter {
    return {
        backend,
        usage: { backend, displayName: backend, read: async () => ({ backend, windows: [], updatedAt: Date.now() }) },
        available: async () => ({ ok: true }),
        listSessions: list,
        start: (_options: SessionStartOptions) => ({}) as AgentSession,
    };
}

function session(id: string, transcriptPath?: string, updatedAt = 1): SessionInfo {
    return { backend: "claude", sessionId: id, title: id, transcriptPath, updatedAt: new Date(updatedAt) };
}

test("SessionIndex persists and reloads a portable snapshot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-index-"));
    const transcript = path.join(dir, "one.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const first = new SessionIndex({ storageDir: dir, adapters: [adapter("claude", async () => [session("one", transcript, 42)])], disableSqlite: true });
    await first.reconcile();
    first.dispose();

    let scanned = 0;
    const second = new SessionIndex({ storageDir: dir, adapters: [adapter("claude", async () => { scanned++; return []; })], disableSqlite: true });
    const cached = second.listCached();
    assert.equal(cached.length, 1);
    assert.equal(cached[0].sessionId, "one");
    assert.equal(cached[0].updatedAt?.getTime(), 42);
    assert.equal(scanned, 0);
});

test("SessionIndex shares concurrent reconciliation and removes deleted provider rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-index-flight-"));
    let calls = 0;
    let rows = [session("one")];
    const index = new SessionIndex({
        storageDir: dir,
        adapters: [adapter("claude", async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return rows;
        })],
    });
    const [a, b] = await Promise.all([index.reconcile(), index.reconcile()]);
    assert.equal(calls, 1);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);

    rows = [];
    await index.reconcile();
    assert.equal(calls, 2);
    assert.deepEqual(index.listCached(), []);
});

test("SessionIndex invalidation ignores an in-flight reconciliation result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-index-invalidate-"));
    let resolve!: (sessions: SessionInfo[]) => void;
    const pending = new Promise<SessionInfo[]>((done) => { resolve = done; });
    const index = new SessionIndex({ storageDir: dir, adapters: [adapter("claude", () => pending)], disableSqlite: true });
    const reconciliation = index.reconcile();
    index.invalidate();
    resolve([session("stale")]);
    await reconciliation;
    assert.deepEqual(index.listCached(), []);
});

test("SessionIndex keeps last known-good rows when one provider fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-index-failure-"));
    let fail = false;
    const source = adapter("claude", async () => {
        if (fail) { throw new Error("provider unavailable"); }
        return [session("one")];
    });
    const index = new SessionIndex({ storageDir: dir, adapters: [source] });
    await index.reconcile();
    fail = true;
    await index.reconcile();
    assert.equal(index.listCached()[0].sessionId, "one");
});

test("SessionIndex ignores incompatible or corrupt snapshots and rebuilds safely", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-index-migrate-"));
    const file = path.join(dir, "session-index.v1.json");
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 999, sessions: [session("stale")] }));
    const index = new SessionIndex({ storageDir: dir, adapters: [adapter("claude", async () => [session("fresh")])], disableSqlite: true });
    assert.deepEqual(index.listCached(), []);
    await index.reconcile();
    assert.equal(index.listCached()[0].sessionId, "fresh");

    fs.writeFileSync(file, "not-json");
    const corrupt = new SessionIndex({ storageDir: dir, adapters: [], disableSqlite: true });
    assert.deepEqual(corrupt.listCached(), []);
});

test("SessionIndex passes cached provider rows to incremental scanners", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-index-incremental-"));
    const source = adapter("claude", async () => [session("one")]);
    const first = new SessionIndex({ storageDir: dir, adapters: [source], disableSqlite: true });
    await first.reconcile();

    let hinted: readonly SessionInfo[] = [];
    const incremental = adapter("claude", async () => { throw new Error("full scan should not run"); });
    incremental.listSessionsIncremental = async (cached) => {
        hinted = cached;
        return [...cached, session("two", undefined, 2)];
    };
    const second = new SessionIndex({ storageDir: dir, adapters: [incremental], disableSqlite: true });
    await second.reconcile();
    assert.equal(hinted.length, 1);
    assert.equal(second.get("claude", "two")?.title, "two");
});
