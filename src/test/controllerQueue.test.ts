import test from "node:test";
import assert from "node:assert/strict";
import { ChatQueue, MessageDedup, recoverPersistedQueue } from "../ui/controllerQueue";

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

    assert.deepEqual(recovered, [{ id: 2, clientMessageId: "second", text: "same", attachments: [] }]);
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

