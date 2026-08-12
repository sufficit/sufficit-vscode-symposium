import assert from "node:assert/strict";
import test from "node:test";
import type {
    ActionEnvelope,
    ChatState,
    SessionState,
    Snapshot,
} from "@microsoft/agent-host-protocol";
import { SymposiumAhpState } from "../ahp/client/state";
import { isPendingQueueHeld, selectPendingMessages } from "../ahp/client/chatSelectors";

const CHAT = "ahp-chat:/22222222-2222-4222-8222-222222222222";

function chatSnapshot(): Snapshot {
    return {
        resource: CHAT,
        fromSeq: 5,
        state: {
            resource: CHAT,
            title: "Client",
            status: 33,
            modifiedAt: "2026-08-09T00:00:00.000Z",
            turns: [],
        } as unknown as ChatState,
    } as Snapshot;
}

function envelope(serverSeq: number, action: unknown): ActionEnvelope {
    return { channel: CHAT, serverSeq, origin: undefined, action } as unknown as ActionEnvelope;
}

test("browser AHP mirror applies chat actions once across duplicate delivery", () => {
    const first = new SymposiumAhpState();
    const second = new SymposiumAhpState();
    first.applySnapshot(chatSnapshot());
    second.applySnapshot(chatSnapshot());
    const envelope = {
        channel: CHAT,
        serverSeq: 6,
        origin: undefined,
        action: {
            type: "chat/pendingMessageSet",
            kind: "queued",
            id: "client-1",
            message: { text: "queued", origin: { kind: "user" } },
        },
    } as unknown as ActionEnvelope;

    // apply() now returns a tri-state ApplyResult ("reduced"/"rejected"/
    // "ignored") instead of a boolean — see D1 in the message-lifecycle
    // hardening plan. A duplicate delivery of the same envelope is "ignored".
    assert.equal(first.apply(envelope), "reduced");
    assert.equal(first.apply(envelope), "ignored");
    assert.equal(second.apply(envelope), "reduced");
    assert.deepEqual(first.chats.get(CHAT), second.chats.get(CHAT));
    assert.equal(first.chats.get(CHAT)?.queuedMessages?.length, 1);
});

test("chat pendingMessageSet with kind send/redirect does not pollute the queue", () => {
    // A send or redirect is dispatched to the backend immediately; it must not
    // appear in queuedMessages. Otherwise the first message of a session shows
    // up both as a sent turn and as a stuck queue entry, because the queue
    // removal depends on a turn-start queuedMessageId that races the shadow
    // runtime's first attachment. Only kind:"queued" (and "steering" via the
    // dedicated field) belong in the queue projection.
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    for (const kind of ["send", "redirect"] as const) {
        state.apply({
            channel: CHAT,
            serverSeq: 100,
            origin: undefined,
            action: {
                type: "chat/pendingMessageSet",
                kind,
                id: `client-${kind}`,
                message: { text: kind, origin: { kind: "user" } },
            },
        } as unknown as ActionEnvelope);
    }
    const chat = state.chats.get(CHAT);
    assert.equal(chat?.queuedMessages?.length ?? 0, 0);
    assert.equal(chat?.steeringMessage, undefined);
});

test("chat turnsLoaded deduplicates turns by id on repeated loads", () => {
    // Reopening a session reloads its history; the reducer must not prepend
    // turns that are already present, otherwise messages double on each open.
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    const turns = [{ id: "history-1" }, { id: "history-2" }];
    const makeEnvelope = (serverSeq: number) =>
        ({
            channel: CHAT,
            serverSeq,
            origin: undefined,
            action: { type: "chat/turnsLoaded", turns } as unknown,
        }) as unknown as ActionEnvelope;
    state.apply(makeEnvelope(100));
    state.apply(makeEnvelope(101)); // same turns, must not duplicate
    const chat = state.chats.get(CHAT);
    assert.equal(chat?.turns?.length, 2);
});

test("first history page replaces a stale restored AHP transcript", () => {
    const state = new SymposiumAhpState();
    const snapshot = chatSnapshot();
    (snapshot.state as ChatState).turns = [
        { id: "stale-1" },
        { id: "stale-2" },
    ] as ChatState["turns"];
    state.applySnapshot(snapshot);

    state.apply(
        envelope(100, {
            type: "chat/turnsLoaded",
            replace: true,
            turns: [{ id: "current-1" }],
        }),
    );

    assert.deepEqual(
        state.chats.get(CHAT)?.turns.map((turn) => turn.id),
        ["current-1"],
    );
});

test("AHP state reconstructs transcript and active lifecycle", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    const started = {
        channel: CHAT,
        serverSeq: 6,
        origin: undefined,
        action: {
            type: "chat/turnStarted",
            turnId: "turn-1",
            startedAt: "2026-08-09T00:00:01.000Z",
            message: { text: "hello", origin: { kind: "user" } },
        },
    } as unknown as ActionEnvelope;
    state.apply(started);
    const chat = state.chats.get(CHAT);
    assert.equal(chat?.activeTurn?.id, "turn-1");
    assert.equal(chat?.activeTurn?.message.text, "hello");
    assert.equal(chat?.turns.length, 0);
});

test("AHP queue rows preserve attachments for edit recovery", () => {
    const items = selectPendingMessages({
        ...(chatSnapshot().state as ChatState),
        queuedMessages: [
            {
                id: "queued-with-file",
                message: {
                    text: "inspect this",
                    origin: { kind: "user" },
                    attachments: [
                        {
                            kind: "simple",
                            id: "attachment-1",
                            representation: "path",
                            value: "/workspace/issue.md",
                        },
                    ],
                },
            },
        ],
    } as unknown as ChatState);

    assert.deepEqual(items, [
        {
            id: "queued-with-file",
            clientMessageId: "queued-with-file",
            text: "inspect this",
            attachments: ["/workspace/issue.md"],
        },
    ]);
});

test("AHP client mirror replaces stale state on snapshot fallback", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    const replacement = chatSnapshot();
    replacement.fromSeq = 100;
    replacement.state = {
        ...(replacement.state as ChatState),
        title: "Caught up",
    } as ChatState;
    state.applySnapshot(replacement);
    assert.equal(state.lastServerSeq, 100);
    assert.equal(state.chats.get(CHAT)?.title, "Caught up");
});

test("session snapshots remain independent from chat snapshots", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot({
        resource: "ahp-session:/11111111-1111-4111-8111-111111111111",
        fromSeq: 1,
        state: {
            provider: "claude",
            title: "Session",
            status: 33,
            lifecycle: "ready",
            activeClients: [],
            chats: [],
        } as unknown as SessionState,
    });
    state.applySnapshot(chatSnapshot());
    assert.equal(state.sessions.size, 1);
    assert.equal(state.chats.size, 1);
});

test("chatReducer supersedes a stuck activeTurn instead of dropping the next turnStarted", () => {
    // Regression: a missed turnComplete used to make the reducer drop the
    // whole next turnStarted, including its queuedMessageId cleanup, leaving
    // an immortal fake queue row.
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    state.apply(
        envelope(101, {
            type: "chat/turnStarted",
            turnId: "turn-1",
            startedAt: "2026-08-10T00:00:00.000Z",
            message: { text: "first", origin: { kind: "user" } },
        }),
    );
    state.apply(
        envelope(102, {
            type: "chat/pendingMessageSet",
            kind: "queued",
            id: "client-2",
            message: { text: "second", origin: { kind: "user" } },
        }),
    );
    // turn-1 never completes (stuck activeTurn) — turn-2 starts anyway.
    state.apply(
        envelope(103, {
            type: "chat/turnStarted",
            turnId: "turn-2",
            queuedMessageId: "client-2",
            startedAt: "2026-08-10T00:00:05.000Z",
            message: { text: "second", origin: { kind: "user" } },
        }),
    );
    const chat = state.chats.get(CHAT);
    assert.equal(chat?.activeTurn?.id, "turn-2");
    assert.equal(chat?.turns.length, 1);
    assert.equal(chat?.turns[0]?.id, "turn-1");
    assert.equal(chat?.turns[0]?.state, "cancelled");
    assert.equal(chat?.queuedMessages, undefined);
});

test("chatReducer clears steeringMessage by id when turnStarted carries queuedMessageId", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    state.apply(
        envelope(101, {
            type: "chat/pendingMessageSet",
            kind: "steering",
            id: "steer-1",
            message: { text: "fix bug", origin: { kind: "user" } },
        }),
    );
    state.apply(
        envelope(102, {
            type: "chat/turnStarted",
            turnId: "turn-1",
            queuedMessageId: "steer-1",
            startedAt: "2026-08-10T00:00:00.000Z",
            message: { text: "fix bug", origin: { kind: "user" } },
        }),
    );
    assert.equal(state.chats.get(CHAT)?.steeringMessage, undefined);
});

test("chatReducer clears steeringMessage by text when turnStarted has no queuedMessageId", () => {
    // The id-lost path: the transport dispatched the steering message
    // directly and the turnStarted event carries no queuedMessageId.
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    state.apply(
        envelope(101, {
            type: "chat/pendingMessageSet",
            kind: "steering",
            id: "steer-2",
            message: { text: "another fix", origin: { kind: "user" } },
        }),
    );
    state.apply(
        envelope(102, {
            type: "chat/turnStarted",
            turnId: "turn-1",
            startedAt: "2026-08-10T00:00:00.000Z",
            message: { text: "another fix", origin: { kind: "user" } },
        }),
    );
    assert.equal(state.chats.get(CHAT)?.steeringMessage, undefined);
});

test("chatReducer turnComplete prunes a ghost queuedMessages row with equal text", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    state.apply(
        envelope(101, {
            type: "chat/pendingMessageSet",
            kind: "queued",
            id: "ghost-1",
            message: { text: "ghost text", origin: { kind: "user" } },
        }),
    );
    // Direct dispatch starts a turn with the same text but no queuedMessageId.
    // The row is now dropped at turn START (v33.1) rather than surviving until
    // the turn completes — the turn's own text identifies it.
    state.apply(
        envelope(102, {
            type: "chat/turnStarted",
            turnId: "turn-1",
            startedAt: "2026-08-10T00:00:00.000Z",
            message: { text: "ghost text", origin: { kind: "user" } },
        }),
    );
    assert.equal(state.chats.get(CHAT)?.queuedMessages, undefined);
    // The turnComplete sweep stays as a second net and must be a no-op here.
    state.apply(envelope(103, { type: "chat/turnComplete", turnId: "turn-1", duration: 10 }));
    assert.equal(state.chats.get(CHAT)?.queuedMessages, undefined);
});

test("pending selector puts steeringMessage first with mode steer", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    state.apply(
        envelope(101, {
            type: "chat/pendingMessageSet",
            kind: "queued",
            id: "client-queued",
            message: { text: "queued item", origin: { kind: "user" } },
        }),
    );
    const steerAction = envelope(102, {
        type: "chat/pendingMessageSet",
        kind: "steering",
        id: "client-steer",
        message: { text: "steer item", origin: { kind: "user" } },
    });
    state.apply(steerAction);
    const chat = state.chats.get(CHAT) as ChatState;

    const items = selectPendingMessages(chat);
    assert.equal(items[0]?.mode, "steer");
    assert.equal(items[0]?.id, "client-steer");
    assert.equal(items[1]?.id, "client-queued");
});

// After a failed turn the host holds the queue — pending messages do NOT
// auto-send. Without the flag the panel just sits there full and unexplained,
// which is what a capacity error leaves behind.
test("pending selector marks the queue held after a failed turn", () => {
    const failed = {
        resource: CHAT,
        title: "Held",
        status: 33,
        modifiedAt: "2026-08-11T00:00:00.000Z",
        turns: [{ id: "t1", state: "error", message: { text: "teste" }, responseParts: [] }],
        queuedMessages: [{ id: "q1", message: { text: "teste", origin: { kind: "user" } } }],
    } as unknown as ChatState;

    assert.equal(isPendingQueueHeld(failed), true);
});

test("a queue behind a healthy turn is not held", () => {
    const running = {
        resource: CHAT,
        title: "Running",
        status: 33,
        modifiedAt: "2026-08-11T00:00:00.000Z",
        turns: [{ id: "t1", state: "complete", message: { text: "a" }, responseParts: [] }],
        activeTurn: { id: "t2", startedAt: "x", message: { text: "b" }, responseParts: [] },
        queuedMessages: [{ id: "q1", message: { text: "later", origin: { kind: "user" } } }],
    } as unknown as ChatState;

    assert.equal(isPendingQueueHeld(running), false);
});
