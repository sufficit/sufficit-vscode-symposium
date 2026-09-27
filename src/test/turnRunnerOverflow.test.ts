import assert from "node:assert/strict";
import test from "node:test";
import { TurnRunner } from "../adapters/openai/turnRunner";
import { createRunnerDeps } from "./openaiRunnerFixture";

function sseResponse(): Response {
    return new Response(
        'data: {"choices":[{"delta":{"content":"replacement"}}]}\n\n' + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
    );
}

test("a failed emergency compaction trims only the outbound history and still sends the active task", async (t) => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const events: Array<{ kind: string; text?: string; message?: string }> = [];
    t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return Promise.resolve(sseResponse());
    });
    const runnerDeps = createRunnerDeps((event) => events.push(event));
    runnerDeps.cfg.maxHistoryMessages = 200;
    runnerDeps.contextWindow = () => 12_000;
    const messages = runnerDeps.getMessages();
    for (let i = 0; i < 8; i++) {
        messages.push({ role: "assistant", content: `old-${i}:` + "x".repeat(20_000) });
    }
    messages.push({ role: "user", content: "latest task must survive" });
    const savedCount = messages.length;
    let foldAttempts = 0;
    runnerDeps.compactForOverflow = () => {
        foldAttempts++;
        return Promise.resolve(false);
    };

    await new TurnRunner(runnerDeps).run();

    assert.ok(foldAttempts > 0, "emergency summary was attempted first");
    assert.equal(requests.length, 1, "only the reduced request is dispatched");
    assert.ok(requests[0].messages.some((m) => m.content === "latest task must survive"));
    assert.ok(requests[0].messages.length < savedCount);
    assert.ok(
        events.some(
            (event) =>
                event.kind === "status-notice" && /Retrying with at most/.test(event.text ?? ""),
        ),
    );
    assert.equal(
        events.some(
            (event) => event.kind === "error" && /Request not sent/.test(event.message ?? ""),
        ),
        false,
    );
    assert.ok(
        messages.some((m) => String(m.content).startsWith("old-0:")),
        "saved history is untouched",
    );
});

test("an oversized latest user message still stops after the bounded fallback", async (t) => {
    let requests = 0;
    const events: Array<{ kind: string; message?: string }> = [];
    t.mock.method(globalThis, "fetch", () => {
        requests++;
        return Promise.resolve(sseResponse());
    });
    const runnerDeps = createRunnerDeps((event) => events.push(event));
    runnerDeps.cfg.maxHistoryMessages = 1;
    runnerDeps.contextWindow = () => 10_000;
    runnerDeps.getMessages()[0].content = "new task" + "x".repeat(100_000);

    await new TurnRunner(runnerDeps).run();

    assert.equal(requests, 0);
    assert.ok(
        events.some(
            (event) => event.kind === "error" && /Request not sent/.test(event.message ?? ""),
        ),
    );
    assert.equal(events.at(-1)?.kind, "turn-end");
});
