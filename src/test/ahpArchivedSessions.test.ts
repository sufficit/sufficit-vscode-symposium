import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import type { SessionState } from "@microsoft/agent-host-protocol";
import type { SymposiumApi } from "../api/symposiumApi";
import {
    AhpHostRuntime,
    isArchivedStatus,
    reconcileArchivedSessions,
    routeAhpClientAction,
} from "../ahp";
import { SessionStore } from "../sessions/store";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CHAT_ID = "44444444-4444-4444-8444-444444444444";
const NATIVE_ID = "019f8ae6-6ce1-7752-b2b5-023c94d63fbc";

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

function hostWithSession(archived = false): AhpHostRuntime {
    const runtime = new AhpHostRuntime();
    runtime.registerSession({
        provider: "codex",
        nativeSessionId: NATIVE_ID,
        title: "Archived candidate",
        stableId: SESSION_ID,
        chatId: CHAT_ID,
        archived,
    });
    return runtime;
}

function sessionState(runtime: AhpHostRuntime): SessionState {
    const handle = runtime.sessionByNative("codex", NATIVE_ID);
    assert.ok(handle, "session handle must exist");
    return runtime.snapshot(handle.sessionResource).state as SessionState;
}

test("SessionStore round-trips the archived flag by bare session id", () => {
    const memory = new MemoryMemento();
    const store = new SessionStore(memory as unknown as vscode.Memento);

    assert.equal(store.setArchivedBySessionId(NATIVE_ID, true), true);
    assert.deepEqual(store.archivedIdList(), [NATIVE_ID]);

    // Survives an extension reload: the flag lives in the memento, not memory.
    const reloaded = new SessionStore(memory as unknown as vscode.Memento);
    assert.deepEqual(reloaded.archivedIdList(), [NATIVE_ID]);

    reloaded.setArchivedBySessionId(NATIVE_ID, false);
    assert.deepEqual(reloaded.archivedIdList(), []);
});

test("projection seeds the archived bit so remote lists hide the session", () => {
    assert.equal(isArchivedStatus(sessionState(hostWithSession(true)).status), true);
    assert.equal(isArchivedStatus(sessionState(hostWithSession(false)).status), false);
});

test("reconcileArchivedSessions aligns projected sessions with the user's store", () => {
    const runtime = hostWithSession(false);

    reconcileArchivedSessions(runtime, new Set([NATIVE_ID]));
    assert.equal(isArchivedStatus(sessionState(runtime).status), true);
    assert.equal(isArchivedStatus(runtime.listSessions()[0].status), true);

    // Unarchiving elsewhere flows back through the same sweep.
    reconcileArchivedSessions(runtime, new Set<string>());
    assert.equal(isArchivedStatus(sessionState(runtime).status), false);
});

test("a remote archive action is persisted to the store instead of being dropped", () => {
    const runtime = hostWithSession(false);
    const handle = runtime.sessionByNative("codex", NATIVE_ID);
    assert.ok(handle);
    const archived = new Set<string>();
    const api = {
        sessions: {
            setArchived: (id: string, value: boolean) => {
                if (value) archived.add(id);
                else archived.delete(id);
                return true;
            },
        },
    } as unknown as SymposiumApi;

    const accepted = routeAhpClientAction(runtime, api, handle.sessionResource, {
        type: "session/isArchivedChanged",
        isArchived: true,
    });

    assert.equal(accepted, undefined);
    assert.deepEqual([...archived], [NATIVE_ID]);
});

test("a malformed archive action is rejected rather than corrupting the store", () => {
    const runtime = hostWithSession(false);
    const handle = runtime.sessionByNative("codex", NATIVE_ID);
    assert.ok(handle);
    const api = {
        sessions: { setArchived: () => true },
    } as unknown as SymposiumApi;

    const rejection = routeAhpClientAction(runtime, api, handle.sessionResource, {
        type: "session/isArchivedChanged",
        isArchived: "yes",
    });

    assert.match(String(rejection), /archive flag/);
});
