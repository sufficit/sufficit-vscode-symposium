import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeEventParser } from "../adapters/claude/eventParser";
import type { AgentEvent } from "../adapters/types";

function parser(
    events: AgentEvent[],
    reasoning = "high",
    activeStates: boolean[] = [],
    model?: string,
): ClaudeEventParser {
    return new ClaudeEventParser({
        model: () => model,
        reasoning: () => reasoning,
        getSessionId: () => "session",
        setSessionId: () => undefined,
        setTurnActive: (active) => activeStates.push(active),
        emit: (event) => events.push(event),
    });
}

test("Claude usage carries the effective model for late UI metadata", () => {
    const events: AgentEvent[] = [];
    const instance = parser(events, "high", [], "claude-opus-5");
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "result",
            usage: { input_tokens: 12, output_tokens: 4 },
            duration_ms: 25,
        }),
    );

    assert.deepEqual(events[0], {
        kind: "usage",
        inputTokens: 12,
        outputTokens: 4,
        cacheRead: 0,
        model: "claude-opus-5",
        contextWindow: 200_000,
    });
});

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

test("Claude ends a turn at the provider message_stop boundary without waiting for result", () => {
    const events: AgentEvent[] = [];
    const activeStates: boolean[] = [];
    const instance = parser(events, "high", activeStates);
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "stream_event",
            event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
        }),
    );
    assert.equal(
        events.some((event) => event.kind === "turn-end"),
        false,
    );

    instance.handleLine(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));
    instance.handleLine(JSON.stringify({ type: "result", duration_ms: 25 }));

    assert.equal(events.filter((event) => event.kind === "turn-end").length, 1);
    assert.deepEqual(activeStates, [false]);
});

test("Claude does not end the top-level turn when an intermediate tool message stops", () => {
    const events: AgentEvent[] = [];
    const instance = parser(events);
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "stream_event",
            event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
        }),
    );
    instance.handleLine(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));

    assert.equal(
        events.some((event) => event.kind === "turn-end"),
        false,
    );
});

test("Claude result closes a turn even when the CLI omits a foreground tool_result", () => {
    const events: AgentEvent[] = [];
    const activeStates: boolean[] = [];
    const instance = parser(events, "high", activeStates);
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "assistant",
            message: {
                content: [{ type: "tool_use", id: "tool-without-result", name: "Read" }],
            },
        }),
    );
    instance.handleLine(JSON.stringify({ type: "result", duration_ms: 15 }));

    assert.equal(events.filter((event) => event.kind === "turn-end").length, 1);
    assert.deepEqual(activeStates, [false]);
});

test("Claude starts each turn with clean foreground tool bookkeeping", () => {
    const events: AgentEvent[] = [];
    const activeStates: boolean[] = [];
    const instance = parser(events, "high", activeStates);
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "stale", name: "Read" }] },
        }),
    );

    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "stream_event",
            event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
        }),
    );
    instance.handleLine(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));

    assert.equal(events.filter((event) => event.kind === "turn-end").length, 1);
    assert.deepEqual(activeStates, [false]);
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

test("Claude closes a completed background follow-up at message_stop without a final result", () => {
    const events: AgentEvent[] = [];
    const activeStates: boolean[] = [];
    const instance = parser(events, "high", activeStates);
    instance.beginTurn();
    instance.handleLine(
        JSON.stringify({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "agent-1", task_type: "local_agent" }],
        }),
    );
    instance.handleLine(JSON.stringify({ type: "result", duration_ms: 100 }));
    instance.handleLine(
        JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] }),
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

    instance.handleLine(
        JSON.stringify({
            type: "stream_event",
            event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
        }),
    );
    instance.handleLine(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));

    assert.equal(events.filter((event) => event.kind === "turn-end").length, 1);
    assert.deepEqual(activeStates, [false]);
});
