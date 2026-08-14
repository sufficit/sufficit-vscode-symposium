import assert from "node:assert/strict";
import test from "node:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { ChatController } from "../application/chatController";
import type { AgentAdapter, SessionStartOptions } from "../adapters/types";
import type { ApplicationPorts } from "../application/ports";
import { seedQueueProjection, createQueueProjectionState, projectQueue } from "../ahp";
import { isPendingQueueHeld } from "../ahp/client/chatSelectors";
import { chatReducer } from "../ahp/chatReducer";

/**
 * Regression suite for FIX A (docs/plans/20260810-message-lifecycle-hardening.md):
 * the AHP projection attaches via subscribeLive and may be restoring a ChatState
 * persisted across a restart whose queuedMessages/steeringMessage rows the
 * host queue no longer has. Live observers previously got no replay, so
 * nothing ever contradicted those rows and they stayed in the Queued panel
 * forever (CONFIRMED in production).
 */

function stubAdapter(): AgentAdapter {
    return {
        backend: "test",
        usage: {
            backend: "test",
            displayName: "Test",
            read: () => Promise.reject(new Error("not used in this test")),
        },
        available: () => Promise.resolve({ ok: true }),
        listSessions: () => Promise.resolve([]),
        start: () => {
            throw new Error("not used in this test");
        },
    } as unknown as AgentAdapter;
}

function stubPorts(): ApplicationPorts {
    // The constructor only stores this bag and passes it down to the turn
    // runner; nothing in subscribeLive() touches it.
    return {} as unknown as ApplicationPorts;
}

test("subscribeLive immediately delivers queue and transient file state", () => {
    const options: SessionStartOptions = { cwd: process.cwd() };
    const controller = new ChatController(stubAdapter(), options, stubPorts());
    const received: unknown[] = [];
    const detach = controller.subscribeLive((message) => received.push(message));

    assert.deepEqual(received, [
        { type: "queue", items: [], held: false, busy: false },
        { type: "changed-files", items: [] },
    ]);

    detach();
});

test("a fresh controller exposes idle shared-render state and seeds safely without a session", () => {
    const controller = new ChatController(stubAdapter(), { cwd: process.cwd() }, stubPorts());

    assert.equal(controller.isBusy, false);
    assert.equal(controller.attentionStatus, undefined);
    assert.equal(controller.seedRenderLog(), false);
    controller.dispose();
});

test("a restored ghost queue row is removed once the host queue snapshot arrives", () => {
    // Simulates a state.json persisted across a restart: the client ChatState
    // still carries a queued row, but this session's host ChatQueue is empty
    // (it never survived the restart) — the exact production scenario.
    const chat: ChatState = {
        resource: "ahp-chat:/55555555-5555-5555-8555-555555555555",
        title: "Reconciliation",
        status: 33,
        modifiedAt: "2026-08-10T00:00:00.000Z",
        turns: [],
        queuedMessages: [
            {
                id: "ghost-1",
                message: { text: "orphaned after restart", origin: { kind: "user" } },
            },
        ],
    } as unknown as ChatState;

    const projection = createQueueProjectionState();
    seedQueueProjection(projection, chat);

    // The host reports an empty queue for this session (attach()/subscribeLive()
    // truth) — projectQueue diffs it against the seeded ids and must emit a
    // removal for the row the host never tracked.
    const actions = projectQueue(projection, []);
    let next = chat;
    for (const item of actions) {
        if (item.channel === "chat") {
            next = chatReducer(next, item.action as never);
        }
    }

    assert.equal(next.queuedMessages, undefined, "the ghost row is gone once host truth arrives");
});

/**
 * A persisted state from the compatibility window can still contain an
 * optimistic chat/pendingMessageSet row the projection never issued. The
 * projection re-seeds from live chat state before every diff, so host queue
 * authority also removes historical rows it never created.
 */
test("an optimistic row the projection never issued is still removed by host truth", () => {
    const optimistic: ChatState = {
        resource: "ahp-chat:/66666666-6666-6666-8666-666666666666",
        title: "Optimistic",
        status: 33,
        modifiedAt: "2026-08-10T00:00:00.000Z",
        turns: [],
        queuedMessages: [
            {
                id: "local-abc-1",
                message: { text: "agora vamos corrigir", origin: { kind: "user" } },
            },
        ],
    } as unknown as ChatState;

    // A projection that has NEVER seen this id — exactly the runtime's state
    // when the transport, not projectQueue, created the row.
    const projection = createQueueProjectionState();
    assert.equal(projection.ids.size, 0);
    assert.deepEqual(
        projectQueue(projection, []).filter((item) => item.channel === "chat"),
        [],
        "without seeding, the diff emits no removal — the row is invisible to it",
    );

    seedQueueProjection(projection, optimistic);
    const actions = projectQueue(projection, []);
    let next = optimistic;
    for (const item of actions) {
        if (item.channel === "chat") {
            next = chatReducer(next, item.action as never);
        }
    }

    assert.equal(next.queuedMessages, undefined);
});

test("host queue projection carries an explicit failure hold into AHP", () => {
    const actions = projectQueue(
        createQueueProjectionState(),
        [{ id: 4, text: "paused", attachments: [] }],
        true,
    );
    const pending = actions.find((item) => item.action.type === "chat/pendingMessageSet");
    const message = pending?.action.message as {
        _meta?: { symposium?: { queueHeld?: boolean } };
    };

    assert.equal(message._meta?.symposium?.queueHeld, true);
});

test("an explicit queue hold survives while an unrelated direct turn runs", () => {
    const running = {
        resource: "ahp-chat:/77777777-7777-5777-8777-777777777777",
        title: "Running beside held work",
        status: 33,
        modifiedAt: "2026-08-12T00:00:00.000Z",
        turns: [{ id: "t1", state: "error", message: { text: "failed" }, responseParts: [] }],
        activeTurn: { id: "t2", startedAt: "x", message: { text: "new" }, responseParts: [] },
        queuedMessages: [
            {
                id: "q1",
                message: {
                    text: "still paused",
                    origin: { kind: "user" },
                    _meta: { symposium: { queueHeld: true } },
                },
            },
        ],
    } as unknown as ChatState;

    assert.equal(isPendingQueueHeld(running), true);
});

/**
 * The first send after an idle period reaches turn-start with no
 * queuedMessageId (the projection no longer holds the pendingUser slot), so
 * every cleanup keyed on the id failed while the bubble still rendered from
 * action.message. Reported repeatedly as "always the first message after
 * inactivity"; while a turn is already running the id is present and the queue
 * behaves. The turn's own text identifies the row.
 */
test("turnStarted without a queuedMessageId still drops the row it is starting on", () => {
    const chat: ChatState = {
        resource: "ahp-chat:/77777777-7777-7777-8777-777777777777",
        title: "Idle first send",
        status: 33,
        modifiedAt: "2026-08-10T00:00:00.000Z",
        turns: [],
        queuedMessages: [
            {
                id: "local-xyz-1",
                message: { text: "me refiro a essas seções rosas", origin: { kind: "user" } },
            },
        ],
    } as unknown as ChatState;

    const next = chatReducer(chat, {
        type: "chat/turnStarted",
        turnId: "session/turn-1",
        // no queuedMessageId — the exact production shape
        startedAt: "2026-08-10T00:00:01.000Z",
        message: { text: "me refiro a essas seções rosas", origin: { kind: "user" } },
    } as never);

    assert.equal(next.queuedMessages, undefined, "the row the turn started on is not pending");
    assert.equal(next.activeTurn?.id, "session/turn-1");
});

// Regression, user-reported: three identical messages queued on purpose. The
// turn that starts on that text accounts for exactly ONE of them; a rule that
// dropped every row with matching text emptied the panel while two were still
// genuinely waiting.
test("a turn starting on a repeated text drops one row, not all of them", () => {
    const chat: ChatState = {
        resource: "ahp-chat:/99999999-9999-9999-8999-999999999999",
        title: "Repeated sends",
        status: 33,
        modifiedAt: "2026-08-11T00:00:00.000Z",
        turns: [],
        queuedMessages: [
            { id: "local-a-5", message: { text: "testes", origin: { kind: "user" } } },
            { id: "local-b-6", message: { text: "testes", origin: { kind: "user" } } },
            { id: "local-c-7", message: { text: "testes", origin: { kind: "user" } } },
        ],
    } as unknown as ChatState;

    const started = chatReducer(chat, {
        type: "chat/turnStarted",
        turnId: "session/turn-1",
        message: { text: "testes", origin: { kind: "user" } },
    } as never);

    assert.deepEqual(
        started.queuedMessages?.map((item) => item.id),
        ["local-b-6", "local-c-7"],
        "the oldest goes, the rest keep waiting",
    );

    // The turnComplete sweep must not finish the job off either.
    const done = chatReducer(started, {
        type: "chat/turnComplete",
        turnId: "session/turn-1",
        duration: 10,
    } as never);
    assert.equal(done.queuedMessages?.length, 1, "one more accounted for, one still pending");
});

test("a queued row with different text survives a turn start", () => {
    const chat: ChatState = {
        resource: "ahp-chat:/88888888-8888-8888-8888-888888888888",
        title: "Real queue",
        status: 33,
        modifiedAt: "2026-08-10T00:00:00.000Z",
        turns: [],
        queuedMessages: [
            { id: "local-a-1", message: { text: "genuinely waiting", origin: { kind: "user" } } },
        ],
    } as unknown as ChatState;

    const next = chatReducer(chat, {
        type: "chat/turnStarted",
        turnId: "session/turn-1",
        message: { text: "something else entirely", origin: { kind: "user" } },
    } as never);

    assert.equal(next.queuedMessages?.length, 1, "real pending work is untouched");
});
