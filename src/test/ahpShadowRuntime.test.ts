import assert from "node:assert/strict";
import test from "node:test";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { AhpShadowRuntime, type AhpShadowSessionInfo, type AhpShadowSource } from "../ahp";

class FakeSource implements AhpShadowSource {
    sessions: AhpShadowSessionInfo[] = [
        {
            backend: "claude",
            sessionId: "native-1",
            title: "Shadow",
            cwd: "/workspace",
        },
    ];
    private readonly observers = new Map<string, Set<(message: unknown) => void>>();

    list(): AhpShadowSessionInfo[] {
        return [...this.sessions];
    }

    follow(id: string, observer: (message: unknown) => void): (() => void) | undefined {
        if (!this.sessions.some((session) => session.sessionId === id)) return undefined;
        const observers = this.observers.get(id) ?? new Set();
        observers.add(observer);
        this.observers.set(id, observers);
        return () => observers.delete(observer);
    }

    emit(id: string, message: unknown): void {
        for (const observer of this.observers.get(id) ?? []) observer(message);
    }
}

test("AHP shadow projects transcript, queue and lifecycle without divergence", () => {
    const source = new FakeSource();
    const shadow = new AhpShadowRuntime(source);
    shadow.sync();
    source.emit("native-1", { type: "user", text: "hello", attachments: [] });
    source.emit("native-1", {
        type: "event",
        event: { kind: "turn-start", logicalTurnId: "turn-1" },
    });
    source.emit("native-1", { type: "event", event: { kind: "text", text: "world" } });
    source.emit("native-1", {
        type: "queue",
        items: [{ id: 1, text: "next", attachments: [], mode: "queue" }],
    });
    source.emit("native-1", { type: "event", event: { kind: "turn-end", durationMs: 5 } });

    const handle = shadow.runtime.handles()[0];
    const chat = shadow.runtime.snapshot(handle.chatResource).state as ChatState;
    assert.equal(chat.turns.length, 1);
    assert.equal(chat.queuedMessages?.length, 1);
    assert.deepEqual(shadow.diagnostics(), { counts: {}, recent: [] });
    shadow.dispose();
});

test("AHP shadow disposes channels when a live controller disappears", () => {
    const source = new FakeSource();
    const shadow = new AhpShadowRuntime(source);
    shadow.sync();
    const resource = shadow.runtime.handles()[0].sessionResource;
    source.sessions = [];
    shadow.sync();

    assert.equal(shadow.runtime.handles().length, 0);
    assert.equal(shadow.runtime.store.has(resource), false);
    shadow.dispose();
});

test("AHP shadow preserves global ordering with a bounded 10,000-action replay", () => {
    const source = new FakeSource();
    const shadow = new AhpShadowRuntime(source, { replayCapacity: 64 });
    shadow.sync();
    for (let index = 0; index < 10_000; index++) {
        source.emit("native-1", {
            type: "event",
            event: { kind: "status-notice", text: `step ${index}`, severity: "info" },
        });
    }

    const retained = shadow.runtime.store.retainedActions();
    assert.equal(retained.length, 64);
    assert.equal(retained.at(-1)?.serverSeq, shadow.runtime.store.serverSeq);
    for (let index = 1; index < retained.length; index++) {
        assert.equal(retained[index].serverSeq, retained[index - 1].serverSeq + 1);
    }
    shadow.dispose();
});

test("AHP shadow projects adapter history when no persisted render log exists", () => {
    const source = new FakeSource();
    const shadow = new AhpShadowRuntime(source);
    shadow.sync();
    source.emit("native-1", {
        type: "history",
        messages: [
            { role: "user", text: "old question", ts: 1 },
            { role: "thinking", text: "old reasoning", ts: 2 },
            { role: "assistant", text: "old answer", ts: 3 },
        ],
    });

    const handle = shadow.runtime.handles()[0];
    const chat = shadow.runtime.snapshot(handle.chatResource).state as ChatState;
    assert.equal(chat.turns.length, 1);
    assert.equal(chat.turns[0].message.text, "old question");
    assert.equal(chat.turns[0].responseParts.length, 2);
    shadow.dispose();
});

test("AHP shadow keeps the stable channel when a new controller receives its native id", () => {
    const source = new FakeSource();
    source.sessions[0].sessionId = "new-1";
    const shadow = new AhpShadowRuntime(source);
    shadow.sync();
    const before = shadow.runtime.handles()[0];

    source.emit("new-1", {
        type: "event",
        event: { kind: "session", sessionId: "native-real" },
    });
    source.sessions[0].sessionId = "native-real";
    shadow.sync();

    const after = shadow.runtime.handles()[0];
    const session = shadow.runtime.snapshot(after.sessionResource).state as SessionState;
    assert.equal(after.sessionResource, before.sessionResource);
    assert.equal(after.nativeSessionId, "native-real");
    assert.equal(
        (session._meta?.symposium as { nativeSessionId: string }).nativeSessionId,
        "native-real",
    );
    shadow.dispose();
});
