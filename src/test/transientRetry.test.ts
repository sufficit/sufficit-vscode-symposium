import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../adapters/types";
import { httpFailureEvent } from "../adapters/openai/turnPreflight";
import type { TurnRunnerDeps } from "../adapters/openai/turnRunnerDeps";
import type { PendingMessage } from "../application/controllerQueue";
import type { ClockPort, ConfigurationPort } from "../application/ports";
import { Turn } from "../application/turn";
import { transcriptMessages } from "../application/controllerTranscript";
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

function configuration(values: Record<string, number | boolean> = {}): ConfigurationPort {
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

function harness(values: Record<string, number | boolean> = {}) {
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
    assert.deepEqual(recoveryOf(h.emitted[0]), {
        id: "intent-1",
        state: "scheduled",
        attempt: 1,
        limit: 3,
        reason: "fetch failed",
        retryAt: 1_000,
    });

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
    assert.equal(retried.automaticRetryId, "intent-1");
    assert.equal(recoveryOf(h.emitted[1])?.state, "running");

    const second = createTurn("turn-2", "retry");
    h.retry.begin(second, retried);
    assert.equal(h.retry.observe(transientError("HTTP 503 Service Unavailable")), false);
    second.recordError();
    second.end();
    assert.equal(h.retry.recover(second), true);
    assert.equal(h.clock.scheduled[1].delay, 2_000);
});

test("an OpenAI HTTP 429 schedules automatic recovery instead of ending silently", async () => {
    const event = await httpFailureEvent(
        { contextWindow: () => 1_000_000 } as unknown as TurnRunnerDeps,
        new Response('{"error":{"type":"rate_limit_error","message":"Too many requests"}}', {
            status: 429,
            statusText: "Too Many Requests",
        }),
        { inputTokens: 44_965, requestChars: 179_860, messageCount: 21, toolCount: 26 },
    );
    assert.equal(event.kind, "error");
    assert.equal(event.retryable, true);

    const h = harness();
    const turn = createTurn("http-429");
    h.retry.begin(turn, { text: "fazer trim end", attachments: [], intentId: "rate-limit" });
    assert.equal(h.retry.observe(event), false, "the raw 429 is replaced by recovery state");
    turn.recordError();
    turn.end();
    assert.equal(h.retry.recover(turn), true);
    assert.equal(recoveryOf(h.emitted[0])?.state, "scheduled");
    assert.equal(recoveryOf(h.emitted[0])?.attempt, 1);
    assert.equal(h.clock.scheduled[0].delay, 1_000);
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
    assert.equal(recoveryOf(h.emitted[0])?.state, "exhausted");
});

test("visible assistant output prevents unsafe replay", () => {
    for (const visible of [
        { kind: "text", text: "resposta parcial" },
        { kind: "thinking", text: "raciocínio parcial" },
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

test("tool activity can resume the same logical intent without another user row", () => {
    const h = harness();
    const turn = createTurn("after-tool");
    h.retry.begin(turn, { text: "pedido", attachments: [], intentId: "intent-tool" });
    assert.equal(h.retry.observe({ kind: "tool-start", toolName: "write_file" }), true);
    assert.equal(h.retry.observe(transientError()), false);
    turn.recordError();
    turn.end();
    assert.equal(h.retry.recover(turn), true);

    h.clock.run(0);
    assert.equal(h.dispatched.length, 1);
    assert.equal(h.dispatched[0].retryOf, "backend-after-tool");
    assert.equal(h.dispatched[0].automaticRetryId, "intent-tool");
});

test("tool activity recovery can be disabled for non-idempotent workflows", () => {
    const h = harness({ transientRetryAfterToolActivity: false });
    const turn = createTurn("unsafe-tool");
    h.retry.begin(turn, { text: "pedido", attachments: [] });
    h.retry.observe({ kind: "tool-end", toolName: "deploy", result: "ok" });
    assert.equal(h.retry.observe(transientError()), true);
    turn.recordError();
    turn.end();
    assert.equal(h.retry.recover(turn), false);
    assert.equal(h.clock.scheduled.length, 0);
});

test("a successful retry resolves the same recovery card", () => {
    const h = harness();
    const first = createTurn("failed");
    h.retry.begin(first, { text: "pedido", attachments: [], intentId: "intent-success" });
    h.retry.observe(transientError());
    first.recordError();
    first.end();
    h.retry.recover(first);
    h.clock.run(0);

    const retried = h.dispatched[0];
    const second = createTurn("successful", "retry");
    h.retry.begin(second, retried);
    second.end("completed");
    assert.equal(h.retry.recover(second), false);
    assert.equal(recoveryOf(h.emitted.at(-1))?.state, "recovered");
    assert.equal(recoveryOf(h.emitted.at(-1))?.id, "intent-success");
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
    assert.equal(recoveryOf(h.emitted.at(-1))?.state, "cancelled");
});

test("retry reason keeps the useful status and discards maintenance-page HTML", () => {
    assert.equal(
        conciseRetryReason(
            "HTTP 503 Service Unavailable <!doctype html><title>Maintenance</title>",
        ),
        "HTTP 503 Service Unavailable",
    );
});

test("automatic retry status is UI-only and excluded from the agent transcript", () => {
    const rows = transcriptMessages([
        { type: "user", text: "Continue the deployment" },
        {
            type: "event",
            event: {
                kind: "status-notice",
                text: "Retrying automatically",
                recovery: {
                    id: "intent-1",
                    state: "scheduled",
                    attempt: 1,
                    limit: 3,
                    retryAt: 1_000,
                },
            },
        },
    ]);
    assert.deepEqual(rows, [{ role: "user", text: "Continue the deployment" }]);
});

function recoveryOf(message: unknown) {
    return (
        message as {
            event?: Extract<AgentEvent, { kind: "status-notice" }>;
        }
    ).event?.recovery;
}
