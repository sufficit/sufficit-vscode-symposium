import test from "node:test";
import assert from "node:assert/strict";
import { ChatQueue, recoverPersistedQueue } from "../ui/controllerQueue";

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
