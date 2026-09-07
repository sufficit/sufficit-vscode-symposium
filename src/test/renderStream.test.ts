import assert from "node:assert/strict";
import test from "node:test";
import { RenderStream } from "../application/renderStream";
import { MISSING_FINAL_RESPONSE_NOTICE } from "../application/finalResponseState";

test("RenderStream keeps replay and live observers synchronized", () => {
    const stream = new RenderStream();
    const projection: unknown[] = [];
    const effects: unknown[] = [];

    const detachProjection = stream.addObserver((message) => projection.push(message));
    stream.emit({ type: "event", event: { kind: "delta", text: "one" } });
    const detachEffects = stream.addLiveObserver((message) => effects.push(message));
    stream.emit({ type: "event", event: { kind: "delta", text: "two" } });

    assert.deepEqual(projection, [
        { type: "event", event: { kind: "delta", text: "one" } },
        { type: "event", event: { kind: "delta", text: "two" } },
    ]);
    assert.deepEqual(effects, [{ type: "event", event: { kind: "delta", text: "two" } }]);

    detachEffects();
    stream.emit({ type: "event", event: { kind: "delta", text: "three" } });
    assert.equal(effects.length, 1);
    assert.equal(projection.length, 3);

    detachProjection();
});

test("RenderStream transient notifications reach live observers without persistence", () => {
    const persisted: unknown[] = [];
    const live: unknown[] = [];
    const stream = new RenderStream((message) => persisted.push(message));
    stream.addLiveObserver((message) => live.push(message));

    stream.notify({ type: "changed-files", items: [] });

    assert.deepEqual(live, [{ type: "changed-files", items: [] }]);
    assert.deepEqual(persisted, []);
    assert.deepEqual(stream.messages, []);
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

    stream.addObserver((message) => replayed.push(message));

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

    stream.addObserver((message) => replayed.push(message));

    const error = replayed[0] as { event: { historical?: boolean; retryable?: boolean } };
    assert.equal(error.event.retryable, true);
    assert.equal(error.event.historical, true);
});

test("replay removes a false missing-response warning caused by terminal TodoWrite", () => {
    const stream = new RenderStream();
    stream.seed([
        { type: "event", event: { kind: "turn-start" } },
        { type: "event", event: { kind: "text", text: "Completed successfully." } },
        { type: "event", event: { kind: "tool-start", toolName: "TodoWrite" } },
        {
            type: "event",
            event: {
                kind: "status-notice",
                severity: "warning",
                terminal: true,
                text: MISSING_FINAL_RESPONSE_NOTICE,
            },
        },
        { type: "event", event: { kind: "turn-end" } },
    ]);

    assert.equal(
        stream.messages.some(
            (message) =>
                (message as { event?: { text?: string } }).event?.text ===
                MISSING_FINAL_RESPONSE_NOTICE,
        ),
        false,
    );
});
