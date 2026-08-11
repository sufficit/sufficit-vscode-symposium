import assert from "node:assert/strict";
import test from "node:test";
import type { HostToWebview } from "../protocol/chat";
import { routeAhpQueueAction } from "../protocol/ahpQueueActions";

function fixture() {
    const calls: string[] = [];
    const delivered: HostToWebview[] = [];
    const client = {
        removeQueued: (chat: string, id: string) => calls.push(`remove:${chat}:${id}`),
        promoteQueued: (chat: string, id: string) => calls.push(`promote:${chat}:${id}`),
        clearQueued: (chat: string) => calls.push(`clear:${chat}`),
        pendingMessage: (_chat: string, id: string) =>
            id === "editable"
                ? { text: "restore me", attachments: ["/workspace/issue.md"] }
                : undefined,
    };
    return {
        calls,
        client,
        delivered,
        deliver: (message: HostToWebview) => delivered.push(message),
    };
}

test("browser AHP queue buttons route to host-authoritative actions", () => {
    const current = fixture();
    assert.equal(
        routeAhpQueueAction(
            current.client,
            "chat-1",
            { type: "queue-remove", id: "remove-me" },
            current.deliver,
        ),
        true,
    );
    assert.equal(
        routeAhpQueueAction(
            current.client,
            "chat-1",
            { type: "queue-promote", id: "next" },
            current.deliver,
        ),
        true,
    );
    assert.equal(
        routeAhpQueueAction(current.client, "chat-1", { type: "queue-clear" }, current.deliver),
        true,
    );
    assert.deepEqual(current.calls, [
        "remove:chat-1:remove-me",
        "promote:chat-1:next",
        "clear:chat-1",
    ]);
});

test("browser AHP queue edit restores text and attachments before removal", () => {
    const current = fixture();
    assert.equal(
        routeAhpQueueAction(
            current.client,
            "chat-1",
            { type: "queue-edit", id: "editable" },
            current.deliver,
        ),
        true,
    );
    assert.deepEqual(current.delivered, [
        {
            type: "load-input",
            text: "restore me",
            attachments: ["/workspace/issue.md"],
        },
    ]);
    assert.deepEqual(current.calls, ["remove:chat-1:editable"]);
});

test("browser AHP queue actions are safely consumed while no chat is bound", () => {
    const current = fixture();
    assert.equal(
        routeAhpQueueAction(
            current.client,
            undefined,
            { type: "queue-remove", id: "stale" },
            current.deliver,
        ),
        true,
    );
    assert.deepEqual(current.calls, []);
    assert.deepEqual(current.delivered, []);
});
