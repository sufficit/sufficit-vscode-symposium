import assert from "node:assert/strict";
import test from "node:test";
import { TurnRunner, type TurnRunnerDeps } from "../adapters/openai/turnRunner";
import type { ChatMessage } from "../adapters/openai/types";

function sseResponse(): Response {
    return new Response(
        'data: {"choices":[{"delta":{"content":"replacement"}}]}\n\n' + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
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
