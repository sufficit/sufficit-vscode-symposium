import test from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { SessionInfo } from "../adapters/types";
import { SessionStore } from "../sessions/store";

class MemoryMemento {
    readonly data = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.data.has(key) ? this.data.get(key) as T : defaultValue;
    }

    update(key: string, value: unknown): Thenable<void> {
        this.data.set(key, value);
        return Promise.resolve();
    }

    keys(): readonly string[] { return [...this.data.keys()]; }
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

    const restored = new SessionStore(memory as unknown as vscode.Memento)
        .decorate([session(branchId)], true);

    assert.equal(restored[0].lineageId, parentId);
    assert.equal(restored[0].parentId, undefined);
});

test("SessionStore persists a terminal warning across extension reloads", () => {
    const memory = new MemoryMemento();
    const info = session("warning-session");
    const store = new SessionStore(memory as unknown as vscode.Memento);
    store.setTerminalStatus(info.sessionId, "warning");

    const restored = new SessionStore(memory as unknown as vscode.Memento)
        .decorate([info], true);

    assert.equal(restored[0].terminalStatus, "warning");
});
