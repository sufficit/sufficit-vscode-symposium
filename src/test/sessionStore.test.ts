import test from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { SessionInfo } from "../adapters/types";
import { SessionStore } from "../sessions/store";

class MemoryMemento {
    readonly data = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
    }

    update(key: string, value: unknown): Thenable<void> {
        this.data.set(key, value);
        return Promise.resolve();
    }

    keys(): readonly string[] {
        return [...this.data.keys()];
    }
}

const session = (sessionId: string): SessionInfo => ({
    backend: "codex",
    sessionId,
    title: sessionId,
});

test("SessionStore persists branch lineage across extension reloads", () => {
    const memory = new MemoryMemento();
    const branchId = "019f8ae6-6ce1-7752-b2b5-023c94d63fbc";
    const parentId = "019f86c6-755f-7df2-8fa7-85d55d2b248d";
    new SessionStore(memory as unknown as vscode.Memento).setLineage(branchId, parentId);

    const restored = new SessionStore(memory as unknown as vscode.Memento).decorate(
        [session(branchId)],
        true,
    );

    assert.equal(restored[0].lineageId, parentId);
    assert.equal(restored[0].parentId, undefined);
});

test("SessionStore persists a terminal warning across extension reloads", () => {
    const memory = new MemoryMemento();
    const info = session("warning-session");
    const store = new SessionStore(memory as unknown as vscode.Memento);
    store.setTerminalStatus(info.sessionId, "warning");

    const restored = new SessionStore(memory as unknown as vscode.Memento).decorate([info], true);

    assert.equal(restored[0].terminalStatus, "warning");
});

test("SessionStore persists the latest model and effort metadata", () => {
    const memory = new MemoryMemento();
    const info = session("metadata-session");
    const store = new SessionStore(memory as unknown as vscode.Memento);
    store.setDisplayMetadata(info.sessionId, "gpt-5.6-sol", "xhigh");

    const restored = new SessionStore(memory as unknown as vscode.Memento).decorate([info], true);

    assert.equal(restored[0].model, "gpt-5.6-sol");
    assert.equal(restored[0].reasoning, "xhigh");
});

test("SessionStore tombstones a deleted session across extension reloads", async () => {
    const memory = new MemoryMemento();
    const info = session("deleted-session");
    await new SessionStore(memory as unknown as vscode.Memento).forget(info);

    const restored = new SessionStore(memory as unknown as vscode.Memento).decorate([info], true);

    assert.deepEqual(restored, []);
});

test("SessionStore notifies the invalidation seam on effective metadata writes", async () => {
    const memory = new MemoryMemento();
    const fired: string[] = [];
    const store = new SessionStore(memory as unknown as vscode.Memento);
    store.setMutationListener((sessionId) => fired.push(sessionId));
    const info = session("mutation-session");

    await store.setTitle(info, "Renamed");
    await store.setArchived(info, true);
    await store.setPinned(info, true);
    store.setParent(info.sessionId, "parent-1");
    store.setLineage(info.sessionId, "lineage-1");
    store.setDisplayMetadata(info.sessionId, "model-x", "high");

    assert.deepEqual(fired, Array.from({ length: 6 }, () => info.sessionId));
});

test("SessionStore movePinned notifies once for an effective reorder", async () => {
    const memory = new MemoryMemento();
    const fired: string[] = [];
    const store = new SessionStore(memory as unknown as vscode.Memento);
    store.setMutationListener((sessionId) => fired.push(sessionId));
    const first = session("pinned-a");
    const second = session("pinned-b");
    await store.setPinned(first, true);
    await store.setPinned(second, true);
    fired.length = 0;

    await store.movePinned(first, 1);

    assert.deepEqual(fired, [first.sessionId]);
});

test("SessionStore stays silent on dedup skips, status writes and deletes", async () => {
    const memory = new MemoryMemento();
    const fired: string[] = [];
    const store = new SessionStore(memory as unknown as vscode.Memento);
    store.setMutationListener((sessionId) => fired.push(sessionId));
    const info = session("quiet-session");

    store.setDisplayMetadata(info.sessionId, "model-x", "high");
    store.setDisplayMetadata(info.sessionId, "model-x", "high"); // dedup: no second write
    store.setParent(info.sessionId, "parent-1");
    store.setParent(info.sessionId, "parent-1"); // idempotent: no second write
    store.setTerminalStatus(info.sessionId, "warning"); // status: not an index mutation
    await store.forget(info); // delete owns its own index eviction (sessionIndex.forget)

    assert.deepEqual(fired, [info.sessionId, info.sessionId]);
});
