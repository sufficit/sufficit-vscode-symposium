import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../adapters/types";
import type { PendingMessage } from "../application/controllerQueue";
import type { ClockPort, ConfigurationPort } from "../application/ports";
import { Turn } from "../application/turn";
import { conciseRetryReason, TransientRetryController } from "../recovery/transientRetry";

class FakeClock implements ClockPort {
    readonly scheduled: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];

    now(): number {
        return 0;
    }

    setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
        this.scheduled.push({ callback, delay: milliseconds, cancelled: false });
        return this.scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }

    clearTimeout(handle: ReturnType<typeof setTimeout>): void {
        const item = this.scheduled[Number(handle) - 1];
        if (item) item.cancelled = true;
    }

    run(index: number): void {
        const item = this.scheduled[index];
        if (item && !item.cancelled) item.callback();
    }
}

function configuration(values: Record<string, number> = {}): ConfigurationPort {
    return {
        language: "pt-BR",
        get<T>(_section: string, key: string, fallback: T): T {
            return (values[key] ?? fallback) as T;
        },
    };
}

function createTurn(id: string, origin: "user" | "retry" = "user"): Turn {
    const turn = new Turn({ id, origin, startedAt: 0, intentId: "intent-1" });
    turn.bindBackendId(`backend-${id}`);
    turn.markSent();
    return turn;
}

function transientError(message = "fetch failed"): AgentEvent {
    return { kind: "error", message, retryable: true };
}

function harness(values: Record<string, number> = {}) {
    const clock = new FakeClock();
    const emitted: unknown[] = [];
    const dispatched: PendingMessage[] = [];
    let statusChanges = 0;
    const retry = new TransientRetryController({
        clock,
        configuration: configuration(values),
        emit: (message) => emitted.push(message),
        dispatch: (message) => dispatched.push(message),
        statusChanged: () => statusChanges++,
    });
    return { retry, clock, emitted, dispatched, statusChanges: () => statusChanges };
}

test("transient recovery retries the same message with bounded exponential pauses", () => {
    const h = harness();
    const original: PendingMessage = {
        text: "continue o trabalho",
        attachments: ["/tmp/evidence.png"],
        clientMessageId: "browser-message-1",
        intentId: "intent-1",
        model: "preset-1",
    };

    const first = createTurn("turn-1");
    h.retry.begin(first, original);
    assert.equal(h.retry.observe(transientError()), false, "raw error is deferred during retry");
    first.recordError();
    first.end();
    assert.equal(h.retry.recover(first), true);
    assert.equal(h.retry.pending, true);
    assert.equal(h.clock.scheduled[0].delay, 1_000);
    assert.equal(h.emitted.length, 1, "only the recovery notice is rendered");

    h.clock.run(0);
    assert.equal(h.retry.pending, false);
    assert.equal(h.dispatched.length, 1);
    const retried = h.dispatched[0];
    assert.equal(retried.text, original.text);
    assert.deepEqual(retried.attachments, original.attachments);
    assert.equal(retried.intentId, original.intentId);
    assert.equal(retried.model, original.model);
    assert.equal(retried.clientMessageId, undefined);
    assert.equal(retried.retryOf, "backend-turn-1");
    assert.equal(retried.interruptedBy, "fetch failed");
    assert.equal(retried.automaticRetryAttempt, 1);

    const second = createTurn("turn-2", "retry");
    h.retry.begin(second, retried);
    assert.equal(h.retry.observe(transientError("HTTP 503 Service Unavailable")), false);
    second.recordError();
    second.end();
    assert.equal(h.retry.recover(second), true);
    assert.equal(h.clock.scheduled[1].delay, 2_000);
});

test("configured retry limit exposes the final error instead of looping forever", () => {
    const h = harness({ transientRetryLimit: 2 });
    const turn = createTurn("final", "retry");
    h.retry.begin(turn, {
        text: "pedido",
        attachments: [],
        automaticRetryAttempt: 2,
    });

    assert.equal(h.retry.observe(transientError("HTTP 503 Service Unavailable")), true);
    turn.recordError();
    turn.end();
    assert.equal(h.retry.recover(turn), false);
    assert.equal(h.clock.scheduled.length, 0);
});

test("visible reply or tool activity prevents unsafe replay", () => {
    for (const visible of [
        { kind: "text", text: "resposta parcial" },
        { kind: "tool-start", toolName: "write_file" },
    ] satisfies AgentEvent[]) {
        const h = harness();
        const turn = createTurn(`visible-${visible.kind}`);
        h.retry.begin(turn, { text: "pedido", attachments: [] });
        assert.equal(h.retry.observe(visible), true);
        assert.equal(h.retry.observe(transientError()), true);
        turn.recordError();
        turn.end();
        assert.equal(h.retry.recover(turn), false);
        assert.equal(h.clock.scheduled.length, 0);
    }
});

test("a manual action cancels the scheduled retry and prevents duplicate dispatch", () => {
    const h = harness();
    const turn = createTurn("cancelled");
    h.retry.begin(turn, { text: "não duplique", attachments: [] });
    h.retry.observe(transientError());
    turn.recordError();
    turn.end();
    h.retry.recover(turn);

    assert.equal(h.retry.cancel(), true);
    h.clock.run(0);
    assert.deepEqual(h.dispatched, []);
    assert.equal(h.retry.pending, false);
});

test("retry reason keeps the useful status and discards maintenance-page HTML", () => {
    assert.equal(
        conciseRetryReason(
            "HTTP 503 Service Unavailable <!doctype html><title>Maintenance</title>",
        ),
        "HTTP 503 Service Unavailable",
    );
});
