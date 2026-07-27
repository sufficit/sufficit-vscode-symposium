import test from "node:test";
import assert from "node:assert/strict";
import {
    cleanupCommitMessage,
    CommitMessageClientError,
    requestCommitMessage,
} from "../scm/commitMessageClient";

type FetchCall = { input: string; init?: RequestInit };

function mockFetch(
    response: Response | ((input: string, init?: RequestInit) => Response | Promise<Response>),
    calls: FetchCall[] = [],
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ input: url, init });
        return typeof response === "function" ? response(url, init) : response;
    }) as typeof fetch;
    return { fetchImpl, calls };
}

test("uses OpenAI chat completions with tools explicitly disabled", async () => {
    const mock = mockFetch(new Response(JSON.stringify({
        choices: [{
            message: { role: "assistant", content: "fix: repair commit generation" },
            finish_reason: "stop",
        }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await requestCommitMessage(
        "https://ai.example/vscode/secret-token/",
        "Sufficit AI - VS Code",
        "system prompt",
        "user prompt",
        { fetchImpl: mock.fetchImpl },
    );

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].input, "https://ai.example/vscode/secret-token/v1/chat/completions");
    const body = JSON.parse(String(mock.calls[0].init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "Sufficit AI - VS Code");
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.tool_choice, "none");
    assert.equal("options" in body, false);
    assert.equal(result.message, "fix: repair commit generation");
    assert.equal(result.protocol, "openai");
    assert.equal(result.finishReason, "stop");
});

test("accepts structured OpenAI text content", async () => {
    const mock = mockFetch(new Response(JSON.stringify({
        choices: [{
            message: {
                content: [
                    { type: "text", text: "feat: add diagnostics" },
                    { type: "output_text", text: "Report gateway failures clearly." },
                ],
            },
        }],
    }), { status: 200 }));

    const result = await requestCommitMessage("https://ai.example/vscode/token", "preset", "s", "u", {
        fetchImpl: mock.fetchImpl,
    });

    assert.equal(result.message, "feat: add diagnostics\nReport gateway failures clearly.");
});

test("accepts an Ollama envelope as a compatibility response", async () => {
    const mock = mockFetch(new Response(JSON.stringify({
        message: { role: "assistant", content: "chore: keep compatibility" },
        done: true,
    }), { status: 200 }));

    const result = await requestCommitMessage("https://ai.example/vscode/token", "preset", "s", "u", {
        fetchImpl: mock.fetchImpl,
    });

    assert.equal(result.message, "chore: keep compatibility");
    assert.equal(result.protocol, "ollama");
});

test("reports tool calls instead of mislabeling them as an empty message", async () => {
    const mock = mockFetch(new Response(JSON.stringify({
        choices: [{
            message: {
                content: null,
                tool_calls: [{ id: "call_1", function: { name: "apply_patch", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
        }],
    }), { status: 200 }));

    await assert.rejects(
        requestCommitMessage("https://ai.example/vscode/token", "preset", "s", "u", {
            fetchImpl: mock.fetchImpl,
        }),
        (error: unknown) => {
            assert.ok(error instanceof CommitMessageClientError);
            assert.match(error.message, /tool calls.*tool_choice=none/i);
            assert.equal(error.status, 200);
            return true;
        },
    );
});

test("reports a successful but incompatible response shape without response content", async () => {
    const mock = mockFetch(new Response(JSON.stringify({
        id: "unexpected",
        result: null,
    }), { status: 200 }));

    await assert.rejects(
        requestCommitMessage("https://ai.example/vscode/token", "preset", "s", "u", {
            fetchImpl: mock.fetchImpl,
        }),
        (error: unknown) => {
            assert.ok(error instanceof CommitMessageClientError);
            assert.match(error.message, /empty or incompatible response/);
            assert.match(error.responseShape ?? "", /keys=id,result/);
            assert.doesNotMatch(error.message, /secret|token/i);
            return true;
        },
    );
});

test("preserves an HTTP error status and safe provider detail", async () => {
    const mock = mockFetch(new Response(JSON.stringify({
        error: { message: "all configured backends are unavailable" },
    }), { status: 503 }));

    await assert.rejects(
        requestCommitMessage("https://ai.example/vscode/token", "preset", "s", "u", {
            fetchImpl: mock.fetchImpl,
        }),
        (error: unknown) => {
            assert.ok(error instanceof CommitMessageClientError);
            assert.equal(error.status, 503);
            assert.match(error.message, /HTTP 503.*backends are unavailable/);
            return true;
        },
    );
});

test("reports invalid and empty JSON responses separately", async () => {
    for (const [body, expected] of [["not-json", /invalid JSON/], ["", /empty HTTP 200 response/]] as const) {
        const mock = mockFetch(new Response(body, { status: 200 }));
        await assert.rejects(
            requestCommitMessage("https://ai.example/vscode/token", "preset", "s", "u", {
                fetchImpl: mock.fetchImpl,
            }),
            expected,
        );
    }
});

test("cleans common model wrappers from the final message", () => {
    assert.equal(cleanupCommitMessage("```text\nfix: repair generation\n```"), "fix: repair generation");
    assert.equal(cleanupCommitMessage("\"feat: add commit support\""), "feat: add commit support");
});
