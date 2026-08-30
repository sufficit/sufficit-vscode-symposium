import test from "node:test";
import assert from "node:assert/strict";
import type { InjectedUserMessage, InjectionDropReason } from "../adapters/types";
import type { ChatMessage } from "../adapters/openai/types";
import { TurnInjectionQueue, canSpliceUserMessage } from "../adapters/openai/turnInjection";

function offered(text: string, sink: string[]): InjectedUserMessage {
    return {
        text,
        onCommitted: () => sink.push(`committed:${text}`),
        onDropped: (reason: InjectionDropReason) => sink.push(`dropped:${text}:${reason}`),
    };
}

test("a user message only splices after a completed tool reply", () => {
    const after = (role: string, extra: Record<string, unknown> = {}) =>
        canSpliceUserMessage([{ role, content: "x", ...extra }] as ChatMessage[]);

    assert.equal(after("tool"), true);
    assert.equal(after("user"), false);
    assert.equal(after("assistant"), false);
    // tool_calls not yet answered — splicing here would orphan them.
    assert.equal(after("assistant", { tool_calls: [{ id: "call_1" }] }), false);
    assert.equal(canSpliceUserMessage([]), false);
});

test("offers are rejected outside an open window", () => {
    const queue = new TurnInjectionQueue();
    const sink: string[] = [];

    assert.equal(queue.offer(offered("before", sink)), false);
    const close = queue.open();
    assert.equal(queue.offer(offered("during", sink)), true);
    close("turn-ended");
    assert.equal(queue.offer(offered("after", sink)), false);

    assert.deepEqual(sink, ["dropped:during:turn-ended"]);
});

test("taken messages are not dropped when the window closes", () => {
    const queue = new TurnInjectionQueue();
    const sink: string[] = [];
    const close = queue.open();
    queue.offer(offered("spliced", sink));

    assert.equal(queue.take().length, 1);
    assert.deepEqual(queue.take(), []);
    close("turn-ended");

    assert.deepEqual(sink, []);
});

test("drops run last-to-first so successive unshifts restore submission order", () => {
    const queue = new TurnInjectionQueue();
    const sink: string[] = [];
    const close = queue.open();
    queue.offer(offered("first", sink));
    queue.offer(offered("second", sink));

    close("turn-ended");

    assert.deepEqual(sink, ["dropped:second:turn-ended", "dropped:first:turn-ended"]);
});

test("opening a new window supersedes leftovers from the previous one", () => {
    const queue = new TurnInjectionQueue();
    const sink: string[] = [];
    queue.open();
    queue.offer(offered("stale", sink));

    queue.open();

    assert.deepEqual(sink, ["dropped:stale:superseded"]);
});

test("a superseded run's close does not steal the current window", () => {
    const queue = new TurnInjectionQueue();
    const sink: string[] = [];
    const staleClose = queue.open();
    queue.open();
    queue.offer(offered("live", sink));

    staleClose("turn-ended");

    assert.deepEqual(sink, [], "the live offer survives the stale close");
    assert.equal(queue.offer(offered("still-open", sink)), true);
});

test("disposal releases anything still pending", () => {
    const queue = new TurnInjectionQueue();
    const sink: string[] = [];
    queue.open();
    queue.offer(offered("pending", sink));

    queue.closeAll("disposed");

    assert.deepEqual(sink, ["dropped:pending:disposed"]);
    assert.equal(queue.offer(offered("later", sink)), false);
});
