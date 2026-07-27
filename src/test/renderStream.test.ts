import assert from "node:assert/strict";
import test from "node:test";
import { RenderStream } from "../ui/renderStream";

test("RenderStream keeps editor and sidebar sinks synchronized", () => {
    const stream = new RenderStream();
    const editor: unknown[] = [];
    const sidebar: unknown[] = [];

    const detachEditor = stream.bindSink((message) => editor.push(message));
    stream.emit({ type: "event", event: { kind: "delta", text: "one" } });
    const detachSidebar = stream.bindSink((message) => sidebar.push(message));
    stream.emit({ type: "event", event: { kind: "delta", text: "two" } });

    assert.equal(stream.hasSink, true);
    assert.deepEqual(editor, [
        { type: "event", event: { kind: "delta", text: "one" } },
        { type: "event", event: { kind: "delta", text: "two" } },
    ]);
    assert.deepEqual(sidebar, editor);

    detachSidebar();
    stream.emit({ type: "event", event: { kind: "delta", text: "three" } });
    assert.equal(sidebar.length, 2);
    assert.equal(editor.length, 3);

    detachEditor();
    assert.equal(stream.hasSink, false);
});

test("terminal retryable error remains actionable after replaying its turn-end", () => {
    const stream = new RenderStream();
    stream.seed([
        { type: "event", event: { kind: "turn-start" } },
        {
            type: "event",
            event: {
                kind: "error",
                message: "Turn ended automatically: no activity from the agent for 5 minutes.",
                retryable: true,
            },
        },
        { type: "event", event: { kind: "turn-end" } },
    ]);
    const replayed: unknown[] = [];

    stream.bindSink((message) => replayed.push(message));

    const error = replayed[1] as { event: { historical?: boolean; retryable?: boolean } };
    assert.equal(error.event.retryable, true);
    assert.equal(error.event.historical, undefined);
});

test("a later conversation turn neutralizes an earlier retry action on replay", () => {
    const stream = new RenderStream();
    stream.seed([
        { type: "event", event: { kind: "error", message: "network failed", retryable: true } },
        { type: "event", event: { kind: "turn-end" } },
        { type: "user", text: "continue" },
        { type: "event", event: { kind: "turn-start" } },
        { type: "event", event: { kind: "text", text: "done" } },
        { type: "event", event: { kind: "turn-end" } },
    ]);
    const replayed: unknown[] = [];

    stream.bindSink((message) => replayed.push(message));

    const error = replayed[0] as { event: { historical?: boolean; retryable?: boolean } };
    assert.equal(error.event.retryable, true);
    assert.equal(error.event.historical, true);
});
