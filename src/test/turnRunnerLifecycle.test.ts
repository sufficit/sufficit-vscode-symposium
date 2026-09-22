import assert from "node:assert/strict";
import test from "node:test";
import { TurnRunner, type TurnRunnerDeps } from "../adapters/openai/turnRunner";
import type { ChatMessage } from "../adapters/openai/types";
import { appendRepeatedToolCallFeedback } from "../adapters/openai/turnNotices";

function sseResponse(): Response {
    return new Response(
        'data: {"choices":[{"delta":{"content":"replacement"}}]}\n\n' + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
    );
}

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

function responsesToolCallResponse(id: string): Response {
    const item = {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: id, name: "read_file" },
    };
    const argumentsDone = {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: JSON.stringify({ path: "package.json" }),
    };
    return new Response(
        `data: ${JSON.stringify(item)}\n\ndata: ${JSON.stringify(argumentsDone)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
    );
}

function responsesTextResponse(): Response {
    return new Response(
        'data: {"type":"response.output_text.delta","delta":"replacement"}\n\ndata: [DONE]\n\n',
        {
            headers: { "content-type": "text/event-stream" },
        },
    );
}

function interruptedResponse(): Response {
    const body = {
        getReader: () => ({
            read: () => Promise.reject(new Error("socket closed")),
            cancel: () => Promise.resolve(),
        }),
    } as unknown as ReadableStream<Uint8Array>;
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        body,
    } as Response;
}

function deps(emit: (event: Parameters<TurnRunnerDeps["emit"]>[0]) => void): TurnRunnerDeps {
    const messages: ChatMessage[] = [{ role: "user", content: "prompt" }];
    let turn = 0;
    return {
        cfg: {
            api: "chat",
            baseUrl: "http://symposium.test/v1",
            model: "test-model",
            models: ["test-model"],
            headers: {},
            apiKey: "test-token",
        },
        options: { cwd: process.cwd() },
        sessionId: "lifecycle-test",
        backend: "openai",
        hub: { configured: () => false } as TurnRunnerDeps["hub"],
        getMessages: () => messages,
        getProgress: () => [],
        bumpTurnNo: () => undefined,
        bumpTurn: () => `lifecycle-test/turn-${++turn}`,
        resumeTurn: () => `lifecycle-test/turn-${++turn}`,
        getResumeTurnId: () => undefined,
        getTurnNo: () => turn,
        getLogicalTurnId: () => `lifecycle-test/turn-${turn}`,
        getIntentId: () => undefined,
        getLastInputTokens: () => 0,
        setLastInputTokens: () => undefined,
        emit,
        model: () => "test-model",
        label: (id) => id,
        contextWindow: () => 100_000,
        headers: () => ({ authorization: "Bearer test-token" }),
        authToken: () => Promise.resolve("test-token"),
        discoverModels: () => Promise.resolve(),
        followupAnchor: () => undefined,
        emitRequestEstimate: () => undefined,
        shellExecutionMode: () => "silent",
        resolveToolPath: () => undefined,
        safePersist: () => undefined,
        led: () => undefined,
        maybeAutoCompact: () => Promise.resolve(false),
        compactForOverflow: () => Promise.resolve(false),
        compactOnTasksComplete: () => Promise.resolve(),
        requestApproval: () => Promise.resolve(false),
    };
}

test("an aborted OpenAI run cannot emit turn-end after its replacement", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const events: { kind: string }[] = [];
    globalThis.fetch = ((_: string | URL, init?: RequestInit) => {
        requests++;
        if (requests === 1) {
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                });
            });
        }
        return Promise.resolve(sseResponse());
    }) as typeof fetch;

    try {
        const runner = new TurnRunner(deps((event) => events.push({ kind: event.kind })));
        const first = runner.run();
        await new Promise<void>((resolve) => setImmediate(resolve));
        runner.cancel();
        const second = runner.run();
        await Promise.all([first, second]);

        assert.equal(requests, 2);
        assert.equal(events.filter((event) => event.kind === "turn-end").length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("an unexpected provider stream drop becomes a retryable error", async () => {
    const originalFetch = globalThis.fetch;
    const events: Array<{ kind: string; message?: string; retryable?: boolean }> = [];
    globalThis.fetch = (() => Promise.resolve(interruptedResponse())) as typeof fetch;

    try {
        const runner = new TurnRunner(deps((event) => events.push(event)) as TurnRunnerDeps);
        await runner.run();

        const error = events.find((event) => event.kind === "error");
        assert.ok(error);
        assert.equal(error.retryable, true);
        assert.match(error.message || "", /connection interrupted/i);
        assert.equal(events.at(-1)?.kind, "turn-end");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("a repeated tool call is skipped and the same turn recovers to a final answer", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const events: Array<{ kind: string; text?: string; terminal?: boolean }> = [];
    globalThis.fetch = (() => {
        requests++;
        return Promise.resolve(
            requests <= 3 ? toolCallResponse(`call-${requests}`) : sseResponse(),
        );
    }) as typeof fetch;

    try {
        const runnerDeps = deps((event) => events.push(event));
        const runner = new TurnRunner(runnerDeps);
        await runner.run();

        assert.equal(requests, 4);
        assert.equal(events.filter((event) => event.kind === "tool-start").length, 2);
        const recovery = events.find(
            (event) => event.kind === "status-notice" && event.text?.includes("recovery 1 of 2"),
        );
        assert.ok(recovery);
        assert.equal(recovery.terminal, undefined);
        assert.equal(
            runnerDeps
                .getMessages()
                .some(
                    (message) => message.role === "assistant" && message.content === "replacement",
                ),
            true,
        );
        assert.equal(events.at(-1)?.kind, "turn-end");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Responses recovery temporarily removes only the repeated tool from the next request", async () => {
    const originalFetch = globalThis.fetch;
    const advertised: string[][] = [];
    const events: Array<{ kind: string; text?: string }> = [];
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
            tools?: Array<{ name: string }>;
        };
        advertised.push(body.tools?.map((tool) => tool.name) ?? []);
        return Promise.resolve(
            advertised.length <= 3
                ? responsesToolCallResponse(`call-${advertised.length}`)
                : responsesTextResponse(),
        );
    }) as typeof fetch;

    try {
        const runnerDeps = deps((event) => events.push(event));
        runnerDeps.cfg.api = "responses";
        await new TurnRunner(runnerDeps).run();

        assert.equal(advertised.length, 4);
        assert.equal(advertised[2].includes("read_file"), true);
        assert.equal(advertised[3].includes("read_file"), false);
        assert.equal(advertised[3].includes("edit_file"), true);
        assert.equal(events.filter((event) => event.kind === "tool-start").length, 2);
        assert.equal(
            runnerDeps.getMessages().some((message) => message.content === "replacement"),
            true,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("a continued turn excludes the previously blocked tool on its first request", async () => {
    const originalFetch = globalThis.fetch;
    let advertised: string[] = [];
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
            tools?: Array<{ name: string }>;
        };
        advertised = body.tools?.map((tool) => tool.name) ?? [];
        return Promise.resolve(responsesTextResponse());
    }) as typeof fetch;

    try {
        const runnerDeps = deps(() => undefined);
        runnerDeps.cfg.api = "responses";
        const messages = runnerDeps.getMessages();
        const args = JSON.stringify({ path: "package.json" });
        messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "prior-call",
                    type: "function",
                    function: { name: "read_file", arguments: args },
                },
            ],
        });
        messages.push({ role: "tool", tool_call_id: "prior-call", content: "prior result" });
        appendRepeatedToolCallFeedback(messages, `read_file:${args}`, ["read_file"], true, 3);
        messages.push({ role: "user", content: "continue" });

        await new TurnRunner(runnerDeps).run();

        assert.equal(advertised.includes("read_file"), false);
        assert.equal(advertised.includes("edit_file"), true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("an allowlist containing only the blocked tool requests no tool calls", async () => {
    const originalFetch = globalThis.fetch;
    let body: { tools?: unknown[]; tool_choice?: string } = {};
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return Promise.resolve(responsesTextResponse());
    }) as typeof fetch;

    try {
        const runnerDeps = deps(() => undefined);
        runnerDeps.cfg.api = "responses";
        runnerDeps.options.aiTools = ["read_file"];
        const messages = runnerDeps.getMessages();
        const args = JSON.stringify({ path: "package.json" });
        messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "prior-call",
                    type: "function",
                    function: { name: "read_file", arguments: args },
                },
            ],
        });
        messages.push({ role: "tool", tool_call_id: "prior-call", content: "prior result" });
        appendRepeatedToolCallFeedback(messages, `read_file:${args}`, ["read_file"], true, 3);
        messages.push({ role: "user", content: "continue" });

        await new TurnRunner(runnerDeps).run();

        assert.equal(body.tools, undefined);
        assert.equal(body.tool_choice, "none");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("a fetch failure during access preparation becomes a retryable error", async () => {
    const events: Array<{ kind: string; message?: string; retryable?: boolean }> = [];
    const runner = new TurnRunner({
        ...deps((event) => events.push(event)),
        authToken: () => Promise.reject(new TypeError("fetch failed")),
    });

    await runner.run();

    const error = events.find((event) => event.kind === "error");
    assert.ok(error);
    assert.equal(error.retryable, true);
    assert.equal(error.message, "fetch failed");
    assert.equal(events.at(-1)?.kind, "turn-end");
});

test("a fetch failure during model discovery stays retryable", async () => {
    const events: Array<{ kind: string; message?: string; retryable?: boolean }> = [];
    const runnerDeps = deps((event) => events.push(event));
    const runner = new TurnRunner({
        ...runnerDeps,
        model: () => "",
        discoverModels: () => Promise.reject(new TypeError("fetch failed")),
    });

    await runner.run();

    const error = events.find((event) => event.kind === "error");
    assert.ok(error);
    assert.equal(error.retryable, true);
    assert.equal(error.message, "fetch failed");
    assert.equal(events.at(-1)?.kind, "turn-end");
});

test("main Sufficit turn sends session provenance in body and trusted header", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        capturedHeaders = new Headers(init?.headers);
        return Promise.resolve(sseResponse());
    }) as typeof fetch;

    try {
        const runner = new TurnRunner(deps(() => undefined));
        await runner.run();

        assert.equal(capturedBody?.session_id, "lifecycle-test");
        assert.equal(capturedHeaders?.get("X-Symposium-Session-Id"), "lifecycle-test");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
