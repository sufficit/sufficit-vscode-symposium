import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AgentAdapter, AgentEvent } from "../adapters/types";
import { ChatController } from "../application/chatController";
import type { ApplicationPorts } from "../application/ports";

function harness(limit = 3) {
    const session = new EventEmitter();
    const sends: unknown[][] = [];
    Object.assign(session, {
        send: (...args: unknown[]) => sends.push(args),
        cancel: () => undefined,
        dispose: () => undefined,
    });
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let timerId = 0;
    const controller = new ChatController(
        {
            backend: "test",
            roleAware: () => true,
            supportsImages: () => true,
            start: () => session,
        } as unknown as AgentAdapter,
        { cwd: process.cwd() },
        {
            configuration: {
                language: "en",
                get: (_section: string, key: string, fallback: unknown) =>
                    key === "transientRetryLimit" ? limit : fallback,
            },
            ids: { create: () => "request-1" },
            clock: {
                now: () => 100,
                setTimeout: (callback: () => void, delay: number) => {
                    timers.set(++timerId, { callback, delay });
                    return timerId;
                },
                clearTimeout: (id: number) => timers.delete(id),
            },
        } as unknown as ApplicationPorts,
    );
    const emitted: Array<{ type?: string; event?: AgentEvent }> = [];
    controller.subscribeLive((message) => emitted.push(message as (typeof emitted)[number]));
    return {
        controller,
        sends,
        timers,
        emitted,
        event: (event: AgentEvent) => session.emit("event", event),
        async send() {
            controller.client.sendMessage(
                { text: "original request", attachments: ["/tmp/test.png"], intentId: "intent-1" },
                "queue",
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(sends.length, 1);
        },
        async retry() {
            const [id, timer] = [...timers][0];
            timers.delete(id);
            timer.callback();
            await new Promise<void>((resolve) => setImmediate(resolve));
        },
        fail(id: string, message = "fetch failed") {
            session.emit("event", { kind: "turn-start", logicalTurnId: id });
            session.emit("event", { kind: "error", message, retryable: true });
            session.emit("event", { kind: "turn-end", logicalTurnId: id });
        },
    };
}

function recovery(message: { event?: AgentEvent }) {
    return message.event?.kind === "status-notice" ? message.event.recovery : undefined;
}

test("normal adapter completion schedules retry through the real ChatController", async (t) => {
    const h = harness();
    t.after(() => h.controller.dispose());
    await h.send();
    h.fail("attempt-0");
    assert.equal(
        h.timers.size,
        1,
        "adapter turn-end must schedule recovery, not expose the deferred error",
    );
    assert.equal(h.controller.isBusy, true);
    assert.equal(
        h.emitted.some((m) => m.event?.kind === "error"),
        false,
    );
    const notice = h.emitted.map(recovery).find((r) => r?.state === "scheduled");
    assert.equal(notice?.attempt, 1);
    assert.equal(notice?.retryAt, 1100);
    await h.retry();
    assert.equal(h.sends.length, 2);
    assert.equal(h.sends[1][0], h.sends[0][0]);
    assert.deepEqual(h.sends[1][1], ["/tmp/test.png"]);
    assert.equal(h.sends[1][3], "intent-1");
    assert.equal(h.sends[1][4], "attempt-0");
    h.event({ kind: "turn-start", logicalTurnId: "attempt-1" });
    h.event({ kind: "text", text: "Done" });
    h.event({ kind: "turn-end", logicalTurnId: "attempt-1" });
    assert.equal(h.controller.isBusy, false);
    assert.equal(h.timers.size, 0);
    assert.equal(
        h.emitted.some((m) => recovery(m)?.state === "recovered"),
        true,
    );
    assert.equal(h.controller.transcriptMessages().filter((m) => m.role === "user").length, 1);
    assert.equal(h.controller.transcript().includes("Retrying"), false);
});

test("normal adapter retries stop at the configured limit", async (t) => {
    const h = harness(2);
    t.after(() => h.controller.dispose());
    await h.send();
    for (let i = 0; i < 2; i++) {
        h.fail(`attempt-${i}`, "HTTP 503 Service Unavailable: update in progress");
        assert.equal(h.timers.size, 1);
        await h.retry();
    }
    h.fail("attempt-2");
    assert.equal(h.sends.length, 3);
    assert.equal(h.timers.size, 0);
    assert.equal(h.controller.isBusy, false);
    assert.equal(
        h.emitted.some((m) => recovery(m)?.state === "exhausted"),
        true,
    );
});

test("cancel during automatic retry countdown prevents replay", async (t) => {
    const h = harness();
    t.after(() => h.controller.dispose());
    await h.send();
    h.fail("attempt-0");
    assert.equal(h.timers.size, 1);
    h.controller.client.interrupt();
    assert.equal(h.timers.size, 0);
    assert.equal(h.sends.length, 1);
});

test("queued work waits for recovery and drains only after success", async (t) => {
    const h = harness();
    t.after(() => h.controller.dispose());
    await h.send();
    h.controller.client.sendText("queued request", "queue");
    h.fail("attempt-0");
    assert.equal(h.sends.length, 1);
    await h.retry();
    assert.equal(h.sends[1][0], "original request");
    h.event({ kind: "turn-start", logicalTurnId: "attempt-1" });
    h.event({ kind: "text", text: "Done" });
    h.event({ kind: "turn-end", logicalTurnId: "attempt-1" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.sends.length, 3);
    assert.equal(h.sends[2][0], "queued request");
});

test("disabled retry and non-retryable errors do not schedule automatic work", async (t) => {
    for (const limit of [0, 3]) {
        const h = harness(limit);
        t.after(() => h.controller.dispose());
        await h.send();
        h.event({ kind: "turn-start", logicalTurnId: "attempt-0" });
        h.event({ kind: "error", message: "failure", retryable: limit === 0 });
        h.event({ kind: "turn-end", logicalTurnId: "attempt-0" });
        assert.equal(h.timers.size, 0);
        assert.equal(h.controller.isBusy, false);
        assert.equal(
            h.emitted.some((m) => m.event?.kind === "error"),
            true,
        );
    }
});
