import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    guardrailStopNotice,
    legacyGuardrailStopNotice,
    toolHopLimitNotice,
} from "../adapters/openai/turnNotices";
import { transcriptMessages } from "../application/controllerTranscript";

test("OpenAI guardrail stops are system warnings, not assistant text", () => {
    const event = guardrailStopNotice("Stopped after repeated tool calls.");

    assert.deepEqual(event, {
        kind: "status-notice",
        severity: "warning",
        text: "Stopped after repeated tool calls.",
        terminal: true,
    });
});

test("system warnings are excluded from the assistant transcript", () => {
    const rows = transcriptMessages([
        { type: "user", text: "Run the task" },
        { type: "event", event: { kind: "text", text: "Working" } },
        { type: "event", event: guardrailStopNotice("Stopped by a loop guard.") },
        { type: "event", event: { kind: "turn-end" } },
    ]);

    assert.deepEqual(rows, [
        { role: "user", text: "Run the task" },
        { role: "assistant", text: "Working", thinking: undefined },
    ]);
});

test("legacy persisted guardrail text is restored as a system warning", () => {
    assert.deepEqual(
        legacyGuardrailStopNotice(
            "\n\n_(stopped: the model repeated the same tool call 6x without progress)_",
        ),
        {
            kind: "status-notice",
            severity: "warning",
            text: "Stopped: the model repeated the same tool call 6 times without progress.",
            terminal: true,
        },
    );
    assert.equal(legacyGuardrailStopNotice("A normal assistant reply"), null);

    assert.deepEqual(
        transcriptMessages([
            { type: "user", text: "Run the task" },
            {
                type: "event",
                event: {
                    kind: "text",
                    text: '_(stopped after 15 tool steps with no reply — send "continue" to resume)_',
                },
            },
            { type: "event", event: { kind: "turn-end" } },
        ]),
        [{ role: "user", text: "Run the task" }],
    );
});

test("turn guardrails emit structured notices instead of markdown assistant messages", () => {
    const source = readFileSync("src/adapters/openai/turnRunner.ts", "utf8");

    assert.match(source, /guardrailStopNotice\(/);
    assert.doesNotMatch(source, /kind:\s*["']text["'][^\n]+stopped/i);
    assert.doesNotMatch(source, /_\(stopped:/i);
});

test("tool-hop cap exposes a local continuation action", () => {
    assert.deepEqual(toolHopLimitNotice(200), {
        kind: "status-notice",
        severity: "warning",
        text: "Paused after 200 tool steps. Continue to let the tool loop make the next request.",
        terminal: true,
        action: "continue-tool-loop",
    });
});

test("legacy tool-hop pause is restored as an actionable system notice", () => {
    assert.deepEqual(
        legacyGuardrailStopNotice(
            '\n\n_(paused after 200 tool steps — send "continue" to proceed)_',
        ),
        toolHopLimitNotice(200),
    );
});

test("continuation stays a local controller command", () => {
    const protocol = readFileSync("src/protocol/chat.ts", "utf8");
    const handler = readFileSync("src/application/controllerMessageHandler.ts", "utf8");
    const session = readFileSync("src/adapters/openai/session.ts", "utf8");

    assert.match(protocol, /type:\s*["']continue["']/);
    assert.match(handler, /case\s*["']continue["'][\s\S]*?ctx\.continueTurn\(\)/);
    assert.match(session, /continueTurn\(\):\s*void\s*\{[\s\S]*?void this\.runner\.run\(\)/);
    assert.match(session, /pendingResumeTurnId\s*=\s*this\.currentLogicalTurnId/);
    assert.doesNotMatch(session, /continueTurn\(\):[\s\S]*?this\.messages\.push/);
});
