import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { ClaudeAdapter } from "../adapters/claude/adapter";
import { CodexAdapter } from "../adapters/codex/adapter";
import { CopilotAdapter } from "../adapters/copilot/adapter";
import { OpenAIAdapter } from "../adapters/openai/adapter";
import type { AgentAdapter, AgentEvent, AgentSession } from "../adapters/types";

const fakeCli = resolve(__dirname, "../../test/fixtures/fake-agent-cli.cjs");

function collectTurn(session: AgentSession, text = "contract prompt"): Promise<AgentEvent[]> {
    return new Promise((resolveTurn, reject) => {
        const events: AgentEvent[] = [];
        const timer = setTimeout(
            () => reject(new Error(`${session.backend} contract timed out`)),
            3000,
        );
        session.on("event", (event: AgentEvent) => {
            events.push(event);
            if (event.kind === "turn-end") {
                clearTimeout(timer);
                resolveTurn(events);
            }
        });
        session.send(text, undefined, undefined, `contract-${session.backend}`);
    });
}

async function assertAdapterContract(adapter: AgentAdapter): Promise<void> {
    const availability = await adapter.available();
    assert.equal(availability.ok, true);
    assert.equal(adapter.usage.backend, adapter.backend);

    const session = adapter.start({ cwd: process.cwd(), model: "fake-model" });
    try {
        assert.equal(session.backend, adapter.backend);
        const events = await collectTurn(session);
        assert.equal(events.at(-1)?.kind, "turn-end");
        if (adapter.backend === "claude") {
            const startIndex = events.findIndex((event) => event.kind === "turn-start");
            const textIndex = events.findIndex((event) => event.kind === "text");
            assert.equal(
                startIndex,
                0,
                `Claude must open the turn before ${JSON.stringify(events)}`,
            );
            assert.ok(textIndex > startIndex, "Claude text must follow its turn-start boundary");
            assert.deepEqual(events[startIndex], {
                kind: "turn-start",
                logicalTurnId: "claude/turn-1",
                intentId: "contract-claude",
            });
        }
        assert.ok(
            events.some((event) => event.kind === "text"),
            `${adapter.backend} emitted ${JSON.stringify(events)}`,
        );
        assert.ok(events.some((event) => event.kind === "session"));
        assert.equal(
            events.some((event) => event.kind === "error"),
            false,
        );
        session.cancel();
    } finally {
        session.dispose();
    }
}

test("Claude adapter satisfies the shared lifecycle contract with a fake CLI", async () => {
    await assertAdapterContract(
        new ClaudeAdapter(() => ({
            executable: fakeCli,
            model: "fake-model",
            permissionMode: "acceptEdits",
            env: {},
        })),
    );
});

test("Codex adapter satisfies the shared lifecycle contract with a fake CLI", async () => {
    await assertAdapterContract(
        new CodexAdapter(() => ({
            executable: fakeCli,
            model: "fake-model",
            reasoning: "default",
            approvalPolicy: "never",
            sandboxMode: "read-only",
        })),
    );
});

test("Copilot adapter satisfies the shared lifecycle contract with a fake CLI", async () => {
    await assertAdapterContract(
        new CopilotAdapter(() => ({ executable: fakeCli, model: "fake-model" })),
    );
});

test("OpenAI adapter satisfies the shared lifecycle contract with a fake server", async () => {
    const server = createServer((request, response) => {
        if (request.url?.endsWith("/models")) {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
            return;
        }
        request.resume();
        request.on("end", () => {
            response.setHeader("content-type", "text/event-stream");
            response.end(
                [
                    'data: {"id":"fake-response","model":"fake-model","choices":[{"delta":{"content":"fake openai reply"}}]}',
                    'data: {"model":"fake-model","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
                    "data: [DONE]",
                    "",
                ].join("\n\n"),
            );
        });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const adapter = new OpenAIAdapter("contract-openai", "Contract OpenAI", () => ({
        api: "chat",
        baseUrl,
        model: "fake-model",
        models: ["fake-model"],
        headers: {},
        apiKey: "fake-token",
    }));
    try {
        await assertAdapterContract(adapter);
    } finally {
        await new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
        );
    }
});
