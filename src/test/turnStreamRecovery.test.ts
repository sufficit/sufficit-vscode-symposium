import assert from "node:assert/strict";
import test from "node:test";
import { TurnRunner } from "../adapters/openai/turnRunner";
import { startStreamWaitNotice } from "../adapters/openai/turnStream";
import { createRunnerDeps } from "./openaiRunnerFixture";

test("a successful but empty Responses stream is an explicit retryable error", async () => {
    const originalFetch = globalThis.fetch;
    const events: Array<{ kind: string; message?: string; retryable?: boolean }> = [];
    globalThis.fetch = (() =>
        Promise.resolve(new Response("data: [DONE]\n\n", { status: 200 }))) as typeof fetch;

    try {
        const runnerDeps = createRunnerDeps((event) => events.push(event));
        runnerDeps.cfg.api = "responses";
        await new TurnRunner(runnerDeps).run();

        const error = events.find((event) => event.kind === "error");
        assert.match(error?.message ?? "", /no answer or tool call/);
        assert.equal(error?.retryable, true);
        assert.equal(
            runnerDeps
                .getMessages()
                .some(
                    (message) =>
                        message.role === "assistant" &&
                        !message.content &&
                        !message.tool_calls?.length,
                ),
            false,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("silent provider wait emits one notice and stops when output arrives", () => {
    const events: Array<{ kind: string; text?: string; transcript?: boolean }> = [];
    let fire: (() => void) | undefined;
    const schedule = ((callback: () => void) => {
        fire = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const wait = startStreamWaitNotice(
        (event) => events.push(event),
        schedule,
        () => {},
    );
    fire?.();
    fire?.();
    assert.equal(events.length, 1);
    assert.match(events[0].text ?? "", /Sufficit AI has not responded/);
    assert.equal(events[0].transcript, true);
    wait.progress();
    fire?.();
    assert.equal(events.length, 1);
});
