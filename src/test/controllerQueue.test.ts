import test from "node:test";
import assert from "node:assert/strict";
import { ChatQueue, MessageDedup, recoverPersistedQueue } from "../application/controllerQueue";
import { routeControllerSend } from "../application/controllerSendRouter";

test("ChatQueue restores persisted messages and keeps ids monotonic", () => {
    const queue = new ChatQueue();
    queue.restore([{ id: 7, text: "restored", attachments: ["/tmp/a.txt"], model: "model-a" }]);
    queue.enqueue({ text: "new", attachments: [] });

    assert.deepEqual(queue.items(), [
        { id: 7, text: "restored", attachments: ["/tmp/a.txt"], model: "model-a" },
        { id: 8, text: "new", attachments: [] },
    ]);
});

test("persisted queue recovery keeps a genuinely pending message", () => {
    const recovered = recoverPersistedQueue([
        { type: "queue", items: [{ id: 3, text: "send me", attachments: [], model: "model-a" }] },
        { type: "event", event: { kind: "turn-end" } },
    ]);

    assert.deepEqual(recovered, [{ id: 3, text: "send me", attachments: [], model: "model-a" }]);
});

test("persisted queue recovery removes a legacy item dispatched after its snapshot", () => {
    const recovered = recoverPersistedQueue([
        { type: "queue", items: [{ id: 1, text: "use gh", attachments: [] }] },
        { type: "event", event: { kind: "turn-end" } },
        { type: "user", text: "use gh", attachments: [], clientMessageId: "local-1" },
    ]);

    assert.deepEqual(recovered, []);
});

test("persisted queue recovery uses client ids for duplicate message text", () => {
    const recovered = recoverPersistedQueue([
        {
            type: "queue",
            items: [
                { id: 1, clientMessageId: "first", text: "same", attachments: [] },
                { id: 2, clientMessageId: "second", text: "same", attachments: [] },
            ],
        },
        { type: "user", clientMessageId: "first", text: "same", attachments: [] },
    ]);

    assert.deepEqual(recovered, [
        { id: 2, clientMessageId: "second", text: "same", attachments: [] },
    ]);
});

// --- Regressão entrega 1B: clientMessageId duplicado é processado uma vez ---
// O defeito: um double-delivery de transporte (ou replay de reconnect da webview)
// re-enviava a mesma mensagem e abria nova execução/ferramentas. O índice host
// agora aceita cada clientMessageId uma única vez.

test("MessageDedup accepts a clientMessageId once, rejects the repeat", () => {
    const dedup = new MessageDedup();
    assert.equal(dedup.accept("local-1"), true, "first sighting is accepted");
    assert.equal(dedup.accept("local-1"), false, "second sighting is rejected");
    assert.equal(dedup.has("local-1"), true);
});

test("MessageDedup accepts distinct clientMessageIds independently", () => {
    const dedup = new MessageDedup();
    assert.equal(dedup.accept("local-1"), true);
    assert.equal(dedup.accept("local-2"), true);
    assert.equal(dedup.accept("local-1"), false);
});

test("MessageDedup bypasses messages with no clientMessageId (retry/edit-resend)", () => {
    const dedup = new MessageDedup();
    // Messages without an id are legitimately resent (retry path) and must not be
    // deduped — every one passes through.
    assert.equal(dedup.accept(undefined), true);
    assert.equal(dedup.accept(undefined), true);
    assert.equal(dedup.accept(undefined), true);
});

test("MessageDedup treats an empty-string clientMessageId as no id", () => {
    const dedup = new MessageDedup();
    // An empty string is falsy/absent — not a real optimistic id, so it bypasses.
    assert.equal(dedup.accept(""), true);
    assert.equal(dedup.accept(""), true);
});

// --- Regressão 1D: redirect preserva a queue ---
// O redirect faz queue.unshift (front-insert) SEM clear. A queue existente deve
// sobreviver ao redirect.

test("redirect uses unshift (front-insert) without clearing the queue", () => {
    const queue = new ChatQueue();
    // Pre-existing queued work.
    queue.enqueue({ text: "queued-1", attachments: [] });
    queue.enqueue({ text: "queued-2", attachments: [] });
    // Redirect front-inserts the correction (simulating onSend redirect branch).
    queue.unshift({ text: "correction", attachments: [] });
    const items = queue.items();
    // Correction is first (runs next), original queue preserved after it.
    assert.equal(items.length, 3);
    assert.equal(items[0].text, "correction");
    assert.equal(items[1].text, "queued-1");
    assert.equal(items[2].text, "queued-2");
});

// The three busy modes differ only in WHERE the message lands and whether the
// running turn is cancelled: redirect cancels + goes first, steer goes first
// without cancelling, queue goes last. None of them discards existing work.
// The steer test below passes no session, i.e. the CLI-backend shape with no
// injectUserMessage — mid-turn injection is covered in steerInjection.test.ts.
test("steer goes to the head of the queue without cancelling the turn", () => {
    const queue = new ChatQueue();
    queue.enqueue({ text: "queued-1", attachments: [] });
    let cancelled = false;
    const dispatched: string[] = [];

    routeControllerSend({ text: "steer-msg", attachments: [], clientMessageId: "steer" }, "steer", {
        queue,
        dedup: new MessageDedup(),
        busy: () => true,
        cancel: () => {
            cancelled = true;
        },
        dispatch: (m) => dispatched.push(m.text),
        emitQueue: () => {},
    });

    assert.equal(cancelled, false);
    assert.deepEqual(dispatched, []);
    const items = queue.items();
    assert.deepEqual(
        items.map((i) => i.text),
        ["steer-msg", "queued-1"],
    );
});

test("queue mode goes to the tail, behind everything already pending", () => {
    const queue = new ChatQueue();
    queue.enqueue({ text: "queued-1", attachments: [] });

    routeControllerSend({ text: "later", attachments: [], clientMessageId: "later" }, "queue", {
        queue,
        dedup: new MessageDedup(),
        busy: () => true,
        cancel: () => assert.fail("queue mode must not cancel"),
        dispatch: () => assert.fail("queue mode must not dispatch while busy"),
        emitQueue: () => {},
    });

    assert.deepEqual(
        queue.items().map((i) => i.text),
        ["queued-1", "later"],
    );
});

// Every send path must broadcast a queue snapshot, including the one that never
// touches the queue: it is the client's only chance to drop a stale Queued row,
// which otherwise sits next to the same message in the transcript.
test("an idle send broadcasts an (empty) queue snapshot even though it dispatches", () => {
    const queue = new ChatQueue();
    const dispatched: string[] = [];
    const snapshots: number[] = [];

    routeControllerSend({ text: "go", attachments: [], clientMessageId: "go" }, "queue", {
        queue,
        dedup: new MessageDedup(),
        busy: () => false,
        cancel: () => assert.fail("an idle send must not cancel"),
        dispatch: (message) => dispatched.push(message.text),
        emitQueue: () => snapshots.push(queue.length),
    });

    assert.deepEqual(dispatched, ["go"]);
    assert.deepEqual(snapshots, [0], "one snapshot, emitted before the dispatch");
});

test("a busy controller always queues a normal send instead of dispatching it", () => {
    const queue = new ChatQueue();
    const dispatched: string[] = [];
    let emitted = 0;

    routeControllerSend(
        { text: "second turn", attachments: [], clientMessageId: "second" },
        "queue",
        {
            queue,
            dedup: new MessageDedup(),
            busy: () => true,
            cancel: () => undefined,
            dispatch: (message) => dispatched.push(message.text),
            emitQueue: () => {
                emitted++;
            },
        },
    );

    assert.deepEqual(dispatched, []);
    assert.equal(emitted, 1);
    assert.deepEqual(
        queue.items().map((message) => message.text),
        ["second turn"],
    );
});
