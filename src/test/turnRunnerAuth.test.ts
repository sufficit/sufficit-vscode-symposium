import assert from "node:assert/strict";
import test from "node:test";
import { appendUserTurn } from "../adapters/openai/sessionSend";
import { TurnRunner } from "../adapters/openai/turnRunner";
import { createRunnerDeps } from "./openaiRunnerFixture";

function toolCallResponse(id: string): Response {
    const payload = JSON.stringify({
        choices: [
            {
                delta: {
                    tool_calls: [
                        {
                            index: 0,
                            id,
                            type: "function",
                            function: {
                                name: "read_file",
                                arguments: JSON.stringify({ path: "package.json" }),
                            },
                        },
                    ],
                },
            },
        ],
    });
    return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
    });
}

test("a rejected token is not reposted when forced refresh returns the same token", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let refreshes = 0;
    const events: Array<{ kind: string; message?: string; text?: string }> = [];
    globalThis.fetch = (() => {
        requests++;
        return Promise.resolve(new Response(null, { status: 401 }));
    }) as typeof fetch;

    try {
        const runnerDeps = createRunnerDeps((event) => events.push(event));
        runnerDeps.cfg.apiKey = undefined;
        runnerDeps.authToken = (forceRefresh) => {
            if (forceRefresh) refreshes++;
            return Promise.resolve("rejected-token");
        };
        runnerDeps.headers = (token) => ({ authorization: `Bearer ${token}` });
        await new TurnRunner(runnerDeps).run();

        assert.equal(requests, 1);
        assert.equal(refreshes, 1);
        assert.ok(
            events.some(
                (event) =>
                    event.kind === "status-notice" &&
                    event.text?.includes("could not be refreshed"),
            ),
        );
        assert.ok(
            events.some((event) => event.kind === "error" && event.message?.includes("HTTP 401")),
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("401 after tool work retries once with a new token but never offers replay", async () => {
    const originalFetch = globalThis.fetch;
    const postedTokens: string[] = [];
    const events: Array<{ kind: string; message?: string; retryable?: boolean; text?: string }> =
        [];
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
        postedTokens.push(String((init?.headers as Record<string, string>)?.authorization));
        return Promise.resolve(
            postedTokens.length === 1
                ? toolCallResponse("saved-call")
                : new Response(null, { status: 401 }),
        );
    }) as typeof fetch;

    try {
        const runnerDeps = createRunnerDeps((event) => events.push(event));
        runnerDeps.cfg.apiKey = undefined;
        runnerDeps.authToken = (forceRefresh) =>
            Promise.resolve(forceRefresh ? "rotated-token" : "initial-token");
        runnerDeps.headers = (token) => ({ authorization: `Bearer ${token}` });
        await new TurnRunner(runnerDeps).run();

        assert.deepEqual(postedTokens, [
            "Bearer initial-token",
            "Bearer initial-token",
            "Bearer rotated-token",
        ]);
        assert.ok(
            events.some(
                (event) =>
                    event.kind === "status-notice" &&
                    event.text?.includes("authorization refreshed"),
            ),
        );
        const error = events.find((event) => event.kind === "error");
        assert.match(error?.message ?? "", /Completed tool results are saved/);
        assert.equal(error?.retryable, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("provider update after completed tools preserves results and permits automatic recovery", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const bodies: string[] = [];
    const events: Array<{ kind: string; message?: string; retryable?: boolean; text?: string }> =
        [];
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        requests++;
        return Promise.resolve(
            requests === 1
                ? toolCallResponse("saved-call")
                : requests === 2
                  ? new Response("Sufficit AI — update in progress", { status: 503 })
                  : new Response(
                        'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n',
                    ),
        );
    }) as typeof fetch;

    try {
        const runnerDeps = createRunnerDeps((event) => events.push(event));
        const runner = new TurnRunner(runnerDeps);
        await runner.run();

        assert.equal(requests, 2);
        assert.ok(
            runnerDeps
                .getMessages()
                .some(
                    (message) => message.role === "tool" && message.tool_call_id === "saved-call",
                ),
        );
        const error = events.find((event) => event.kind === "error");
        assert.match(error?.message ?? "", /Completed tool results are saved/);
        assert.equal(error?.retryable, true);
        appendUserTurn(
            {
                cfg: runnerDeps.cfg,
                sessionId: runnerDeps.sessionId,
                messages: runnerDeps.getMessages(),
                turnSeq: 1,
                led: runnerDeps.led,
            },
            { text: "prompt", retry: true },
        );
        await runner.run();
        assert.equal(requests, 3);
        assert.equal(bodies[1], bodies[2]);
        assert.equal(runnerDeps.getMessages().filter((m) => m.role === "user").length, 1);
        assert.equal(events.filter((e) => e.kind === "tool-start").length, 1);
        assert.equal(events.filter((e) => e.kind === "error").length, 1);
        assert.ok(events.some((e) => e.kind === "text" && e.text === "Done"));
    } finally {
        globalThis.fetch = originalFetch;
    }
});
