import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeEventParser } from "../adapters/claude/eventParser";
import type { AgentEvent } from "../adapters/types";

function parser(
    events: AgentEvent[],
    reasoning = "high",
    activeStates: boolean[] = [],
): ClaudeEventParser {
    return new ClaudeEventParser({
        model: () => undefined,
        reasoning: () => reasoning,
        getSessionId: () => "session",
        setSessionId: () => undefined,
        setTurnActive: (active) => activeStates.push(active),
        emit: (event) => events.push(event),
    });
}

test("Claude live text keeps provider timestamp, model and effort", () => {
    const events: AgentEvent[] = [];
    const timestamp = "2026-08-19T01:27:00.000Z";
    const instance = parser(events);
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "stream_event",
            timestamp,
            event: {
                type: "message_start",
                message: { model: "claude-opus-5" },
            },
        }),
    );
    instance.handleLine(
        JSON.stringify({
            type: "stream_event",
            timestamp,
            event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "Resposta" },
            },
        }),
    );

    assert.deepEqual(events.at(-1), {
        kind: "text",
        text: "Resposta",
        model: "claude-opus-5",
        reasoning: "high",
        ts: Date.parse(timestamp),
    });
});

test("Claude starts a new timestamp window for each turn", () => {
    const events: AgentEvent[] = [];
    const instance = parser(events);
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "stream_event",
            timestamp: "2026-08-18T10:00:00.000Z",
            event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "A" },
            },
        }),
    );
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "stream_event",
            timestamp: "2026-08-19T10:00:00.000Z",
            event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "B" },
            },
        }),
    );

    assert.equal(
        (events[0] as Extract<AgentEvent, { kind: "text" }>).ts,
        Date.parse("2026-08-18T10:00:00.000Z"),
    );
    assert.equal(
        (events[1] as Extract<AgentEvent, { kind: "text" }>).ts,
        Date.parse("2026-08-19T10:00:00.000Z"),
    );
});

test("Claude timestamps each response block from its own provider event", () => {
    const events: AgentEvent[] = [];
    const instance = parser(events);
    instance.beginTurn();
    for (const [timestamp, text] of [
        ["2026-08-19T10:00:00.000Z", "before tool"],
        ["2026-08-19T10:05:00.000Z", "after tool"],
    ]) {
        instance.handleLine(
            JSON.stringify({
                type: "stream_event",
                timestamp,
                event: {
                    type: "content_block_delta",
                    delta: { type: "text_delta", text },
                },
            }),
        );
    }

    assert.deepEqual(
        events.map((event) => (event.kind === "text" ? event.ts : undefined)),
        [Date.parse("2026-08-19T10:00:00.000Z"), Date.parse("2026-08-19T10:05:00.000Z")],
    );
});

test("Claude keeps a parent turn active until its background agent follow-up finishes", () => {
    const events: AgentEvent[] = [];
    const activeStates: boolean[] = [];
    const instance = parser(events, "xhigh", activeStates);
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "assistant",
            timestamp: "2026-08-19T10:00:00.000Z",
            message: {
                model: "claude-opus-5",
                content: [{ type: "tool_use", id: "tool-agent", name: "Agent", input: {} }],
            },
        }),
    );
    instance.handleLine(
        JSON.stringify({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "agent-1", task_type: "local_agent", description: "work" }],
        }),
    );
    instance.handleLine(
        JSON.stringify({
            type: "user",
            message: {
                content: [{ type: "tool_result", tool_use_id: "tool-agent", content: "launched" }],
            },
            toolUseResult: { status: "async_launched", isAsync: true, agentId: "agent-1" },
        }),
    );
    instance.handleLine(JSON.stringify({ type: "result", duration_ms: 100, total_cost_usd: 0.01 }));
    assert.equal(
        events.some((event) => event.kind === "turn-end"),
        false,
    );

    instance.handleLine(
        JSON.stringify({
            type: "assistant",
            timestamp: "2026-08-19T10:06:00.000Z",
            message: {
                model: "claude-sonnet-5",
                content: [{ type: "text", text: "delegated update" }],
            },
        }),
    );
    instance.handleLine(
        JSON.stringify({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
        }),
    );
    instance.handleLine(
        JSON.stringify({
            type: "system",
            subtype: "task_notification",
            task_id: "agent-1",
            status: "completed",
        }),
    );
    assert.equal(
        events.some((event) => event.kind === "turn-end"),
        false,
    );
    instance.handleLine(JSON.stringify({ type: "result", duration_ms: 360_000 }));

    const update = events.find(
        (event): event is Extract<AgentEvent, { kind: "text" }> =>
            event.kind === "text" && event.text === "delegated update",
    );
    assert.deepEqual(update, {
        kind: "text",
        text: "delegated update",
        model: "claude-sonnet-5",
        reasoning: "xhigh",
        ts: Date.parse("2026-08-19T10:06:00.000Z"),
    });
    assert.equal(events.filter((event) => event.kind === "turn-end").length, 1);
    assert.deepEqual(activeStates, [false]);
});
