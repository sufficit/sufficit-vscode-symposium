import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { ChatQueue, MessageDedup } from "../application/controllerQueue";
import { routeControllerSend } from "../application/controllerSendRouter";
import { describeStorageFull, isStorageFullError } from "../diskErrors";
import { leaseErrorEvent } from "../adapters/claude/sessionCoordination";

function busyContext(queue: ChatQueue, runningText?: string) {
    const logs: string[] = [];
    return {
        logs,
        context: {
            queue,
            dedup: new MessageDedup(),
            busy: () => true,
            cancel: () => undefined,
            dispatch: () => assert.fail("must not dispatch while busy"),
            emitQueue: () => undefined,
            log: (line: string) => logs.push(line),
            turns: runningText
                ? ({ current: { request: { text: runningText, attachments: [] } } } as never)
                : undefined,
        },
    };
}

test("repeated Retry clicks while busy queue the request only once", () => {
    const queue = new ChatQueue();
    const { context, logs } = busyContext(queue);
    for (let click = 0; click < 4; click++) {
        routeControllerSend(
            { text: "limpe o tmp", attachments: [], retryOf: "retry", interruptedBy: "x" },
            "send",
            context,
        );
    }
    assert.equal(queue.items().length, 1);
    assert.equal(logs.filter((line) => line.includes("retry ignored")).length, 3);
});

test("Retry of the request already running is not queued again", () => {
    const queue = new ChatQueue();
    const { context } = busyContext(queue, "limpe o tmp");
    routeControllerSend(
        { text: "limpe o tmp", attachments: [], retryOf: "retry" },
        "send",
        context,
    );
    assert.equal(queue.items().length, 0);
});

test("ordinary repeated sends while busy are still queued", () => {
    const queue = new ChatQueue();
    const { context } = busyContext(queue);
    routeControllerSend({ text: "ok", attachments: [] }, "send", context);
    routeControllerSend({ text: "ok", attachments: [] }, "send", context);
    assert.equal(queue.items().length, 2);
});

test("storage-full detection covers ENOSPC, EDQUOT and libuv unknown -122", () => {
    assert.equal(isStorageFullError(Object.assign(new Error("x"), { code: "ENOSPC" })), true);
    assert.equal(isStorageFullError(Object.assign(new Error("x"), { code: "EDQUOT" })), true);
    assert.equal(
        isStorageFullError(
            new Error("Unknown system error -122: Unknown system error -122, write"),
        ),
        true,
    );
    assert.equal(isStorageFullError(Object.assign(new Error("x"), { errno: -122 })), true);
    assert.equal(isStorageFullError(Object.assign(new Error("x"), { code: "EACCES" })), false);
    const text = describeStorageFull(os.tmpdir(), new Error("Unknown system error -122"));
    assert.match(text, /No space left/);
    assert.match(text, /free of/);
    assert.ok(text.includes(os.tmpdir()));
});

test("storage-full lease disables the automatic retry loop but keeps manual Retry", () => {
    const full = leaseErrorEvent({ message: "No space left", storageFull: true });
    assert.equal(full.retryable, true);
    assert.equal(full.automaticRetry, false);
    const busy = leaseErrorEvent({ message: "already running" });
    assert.equal(busy.retryable, true);
    assert.equal(busy.automaticRetry, undefined);
});
