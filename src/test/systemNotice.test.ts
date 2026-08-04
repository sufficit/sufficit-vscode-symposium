import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardrailStopNotice, legacyGuardrailStopNotice } from "../adapters/openai/turnNotices";
import { transcriptMessages } from "../ui/controllerTranscript";

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
        legacyGuardrailStopNotice("\n\n_(stopped: the model repeated the same tool call 6x without progress)_"),
        {
            kind: "status-notice",
            severity: "warning",
            text: "Stopped: the model repeated the same tool call 6 times without progress.",
            terminal: true,
        },
    );
    assert.equal(legacyGuardrailStopNotice("A normal assistant reply"), null);

    assert.deepEqual(transcriptMessages([
        { type: "user", text: "Run the task" },
        { type: "event", event: { kind: "text", text: "_(stopped after 15 tool steps with no reply — send \"continue\" to resume)_" } },
        { type: "event", event: { kind: "turn-end" } },
    ]), [{ role: "user", text: "Run the task" }]);
});

test("turn guardrails emit structured notices instead of markdown assistant messages", () => {
    const source = readFileSync("src/adapters/openai/turnRunner.ts", "utf8");

    assert.match(source, /guardrailStopNotice\(/);
    assert.doesNotMatch(source, /kind:\s*["']text["'][^\n]+stopped/i);
    assert.doesNotMatch(source, /_\(stopped:/i);
});
