import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePeerQueue } from "../application/controllerPeerQueue";
import { ChatQueue } from "../application/controllerQueue";
import type { RenderLogRecord } from "../renderLog";

test("owner merges a follower proposal and emits one canonical queue", () => {
    const queue = new ChatQueue();
    queue.restore([{ id: 1, clientMessageId: "local", text: "local", attachments: [] }]);
    let canonical = 0;
    let normalized = 0;
    let drained = 0;
    const result = reconcilePeerQueue(
        queueMessage([{ id: 1, clientMessageId: "peer", text: "peer", attachments: [] }], true),
        peerRecord(false),
        {
            queue,
            isOwner: true,
            emitCanonical: () => canonical++,
            ingestNormalized: () => normalized++,
            snapshot: () => ({ type: "queue", items: queue.items() }),
            drain: () => drained++,
        },
    );

    assert.equal(result, false);
    assert.deepEqual(
        queue.items().map((item) => item.text),
        ["local", "peer"],
    );
    assert.equal(queue.isHeld, true);
    assert.equal(canonical, 1);
    assert.equal(normalized, 0);
    assert.equal(drained, 1);
});

test("follower replaces its queue from an authoritative owner snapshot", () => {
    const queue = new ChatQueue();
    queue.restore([{ id: 1, text: "stale", attachments: [] }]);
    const ingested: unknown[] = [];
    let canonical = 0;
    let drained = 0;
    const authoritative = queueMessage([{ id: 8, text: "owner", attachments: [] }], false);
    const result = reconcilePeerQueue(authoritative, peerRecord(true), {
        queue,
        isOwner: false,
        emitCanonical: () => canonical++,
        ingestNormalized: (message) => ingested.push(message),
        snapshot: () => ({ type: "queue", items: queue.items(), held: queue.isHeld }),
        drain: () => drained++,
    });

    assert.equal(result, false);
    assert.deepEqual(
        queue.items().map((item) => item.text),
        ["owner"],
    );
    assert.equal(queue.isHeld, false);
    assert.equal(canonical, 0);
    assert.equal(ingested.length, 1);
    assert.equal(drained, 1);
});

test("follower normalizes another follower proposal without persisting it", () => {
    const queue = new ChatQueue();
    let normalized: unknown;
    reconcilePeerQueue(
        queueMessage([{ id: 3, text: "peer", attachments: [] }], false),
        peerRecord(false),
        {
            queue,
            isOwner: false,
            emitCanonical: () => assert.fail("a follower cannot publish canonical state"),
            ingestNormalized: (message) => {
                normalized = message;
            },
            snapshot: () => ({ type: "queue", items: queue.items() }),
            drain: () => undefined,
        },
    );

    assert.equal(queue.items()[0].intentId, "render-peer:peer:3");
    assert.deepEqual(normalized, { type: "queue", items: queue.items() });
});

test("non-queue render messages are not intercepted", () => {
    const queue = new ChatQueue();
    assert.equal(
        reconcilePeerQueue({ type: "event" }, peerRecord(true), {
            queue,
            isOwner: false,
            emitCanonical: () => assert.fail("not called"),
            ingestNormalized: () => assert.fail("not called"),
            snapshot: () => assert.fail("not called"),
            drain: () => assert.fail("not called"),
        }),
        undefined,
    );
});

function queueMessage(items: unknown[], held: boolean): unknown {
    return { type: "queue", items, held };
}

function peerRecord(authoritative: boolean): RenderLogRecord {
    return {
        message: undefined,
        writer: { id: "peer", pid: 42 },
        authoritative,
    };
}
