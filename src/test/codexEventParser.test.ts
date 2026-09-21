import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexEventParser } from "../adapters/codex/eventParser";
import type { AgentEvent } from "../adapters/types";

function parserHarness() {
    const events: AgentEvent[] = [];
    let sessionId: string | undefined;
    const parser = new CodexEventParser({
        model: () => "gpt-6-astra",
        setModel: () => undefined,
        reasoning: () => "high",
        getSessionId: () => sessionId,
        setSessionId: (id) => {
            sessionId = id;
        },
        isCancelled: () => false,
        setReportedError: () => undefined,
        configuredContextWindow: () => 200_000,
        emit: (event) => events.push(event),
        emitTurnEnd: () => events.push({ kind: "turn-end" }),
    });
    const send = (event: unknown) => parser.handleLine(JSON.stringify(event));
    return { events, parser, send };
}

test("Codex classifies public progress separately from the final Astra answer", () => {
    const { events, parser, send } = parserHarness();
    parser.beginTurn();

    send({
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "Vou ler o arquivo." },
    });
    assert.deepEqual(events, []);

    send({
        type: "item.started",
        item: {
            id: "command-1",
            type: "command_execution",
            command: "/bin/bash -lc 'cat package.json'",
            status: "in_progress",
        },
    });
    send({
        type: "item.completed",
        item: {
            id: "command-1",
            type: "command_execution",
            command: "/bin/bash -lc 'cat package.json'",
            aggregated_output: '{"version":"2026.921.1"}\n',
            exit_code: 0,
            status: "completed",
        },
    });
    send({
        type: "item.completed",
        item: { id: "message-2", type: "agent_message", text: "A versão é 2026.921.1." },
    });
    send({ type: "turn.completed" });

    assert.deepEqual(events, [
        { kind: "thinking", text: "Vou ler o arquivo." },
        {
            kind: "tool-start",
            toolName: "exec",
            detail: "/bin/bash -lc 'cat package.json'",
            toolId: "command-1",
        },
        {
            kind: "tool-end",
            toolName: "exec",
            detail: "/bin/bash -lc 'cat package.json'",
            toolId: "command-1",
            result: '{"version":"2026.921.1"}\n',
        },
        {
            kind: "text",
            text: "A versão é 2026.921.1.",
            model: "gpt-6-astra",
            reasoning: "high",
        },
        { kind: "turn-end" },
    ]);
});

test("Codex surfaces reasoning summaries without exposing raw reasoning content", () => {
    const { events, send } = parserHarness();

    send({
        type: "item.completed",
        item: {
            id: "reasoning-1",
            type: "reasoning",
            summary: [{ text: "Comparando os dois fluxos." }, { text: "A causa está no parser." }],
            content: [{ text: "private chain of thought" }],
        },
    });

    assert.deepEqual(events, [
        {
            kind: "thinking",
            text: "Comparando os dois fluxos.\n\nA causa está no parser.",
        },
    ]);
    assert.equal(JSON.stringify(events).includes("private chain of thought"), false);
});

test("Codex enriches completed MCP calls even when the start event was missed", () => {
    const { events, send } = parserHarness();

    send({
        type: "item.completed",
        item: {
            id: "mcp-1",
            type: "mcp_tool_call",
            server: "sufficit-ai",
            tool: "memory_search",
            arguments: '{"query":"astra"}',
            result: { content: [{ type: "text", text: "found" }] },
            status: "completed",
        },
    });

    assert.deepEqual(events, [
        {
            kind: "tool-start",
            toolName: "memory_search",
            detail: "sufficit-ai",
            toolId: "mcp-1",
            input: '{\n  "query": "astra"\n}',
        },
        {
            kind: "tool-end",
            toolName: "memory_search",
            toolId: "mcp-1",
            result: '{"content":[{"type":"text","text":"found"}]}',
        },
    ]);
});

test("Codex does not duplicate legacy tool rows without item ids", () => {
    const { events, send } = parserHarness();
    const item = {
        type: "command_execution",
        command: "pwd",
        aggregated_output: "/workspace\n",
        exit_code: 0,
    };

    send({ type: "item.started", item: { ...item, status: "in_progress" } });
    send({ type: "item.completed", item: { ...item, status: "completed" } });

    assert.deepEqual(
        events.map((event) => event.kind),
        ["tool-start", "tool-end"],
    );
});

test("Codex file changes expose path and diff counts", () => {
    const { events, send } = parserHarness();
    const item = {
        id: "patch-1",
        type: "file_change",
        changes: [
            {
                path: "/workspace/src/app.ts",
                kind: "update",
                diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new\n+extra",
            },
        ],
        status: "completed",
    };

    send({ type: "item.started", item: { ...item, status: "in_progress" } });
    send({ type: "item.completed", item });

    assert.equal(events.length, 2);
    assert.deepEqual(events[0], {
        kind: "tool-start",
        toolName: "Edit",
        detail: "/workspace/src/app.ts",
        toolId: "patch-1",
        input: JSON.stringify(item.changes, null, 2),
        path: "/workspace/src/app.ts",
        added: 2,
        removed: 1,
    });
    assert.deepEqual(events[1], {
        kind: "tool-end",
        toolName: "Edit",
        toolId: "patch-1",
        result: undefined,
    });
});
