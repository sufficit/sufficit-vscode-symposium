import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeEventParser } from "../adapters/claude/eventParser";
import type { AgentEvent } from "../adapters/types";

function parser(events: AgentEvent[], reasoning = "high"): ClaudeEventParser {
    return new ClaudeEventParser({
        model: () => undefined,
        reasoning: () => reasoning,
        getSessionId: () => "session",
        setSessionId: () => undefined,
        setTurnActive: () => undefined,
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
