import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    guardrailStopNotice,
    legacyGuardrailStopNotice,
    toolHopLimitNotice,
} from "../adapters/openai/turnNotices";
import { replayRows, transcriptMessages } from "../application/controllerTranscript";
import { loadControllerHistory } from "../application/controllerHistory";
import { appendRender } from "../renderLog";
import type { AgentAdapter } from "../adapters/types";

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

test("render-log transcript preserves the model and effort for assistant rows", () => {
    assert.deepEqual(
        replayRows([
            {
                type: "event",
                event: {
                    kind: "text",
                    text: "A",
                    model: "claude-opus-5",
                    reasoning: "high",
                },
            },
            { type: "event", event: { kind: "text", text: "B" } },
            { type: "event", event: { kind: "turn-end" } },
        ]),
        [
            {
                role: "assistant",
                text: "AB",
                thinking: undefined,
                model: "claude-opus-5",
                reasoning: "high",
            },
        ],
    );
    assert.deepEqual(
        replayRows([
            {
                type: "history",
                messages: [
                    {
                        role: "assistant",
                        text: "Stored reply",
                        model: "codex-1",
                        reasoning: "medium",
                    },
                ],
            },
        ]),
        [
            {
                role: "assistant",
                text: "Stored reply",
                thinking: undefined,
                model: "codex-1",
                reasoning: "medium",
            },
        ],
    );
});

test("old render logs use session metadata as a compatibility fallback", async () => {
    const originalHome = process.env.HOME;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-render-history-"));
    process.env.HOME = path.join(root, "home");
    fs.mkdirSync(process.env.HOME, { recursive: true });
    const sessionId = "legacy-render-session";
    const emitted: unknown[] = [];
    try {
        appendRender(sessionId, {
            type: "event",
            event: { kind: "text", text: "Legacy reply" },
        });
        appendRender(sessionId, { type: "event", event: { kind: "turn-end" } });
        await loadControllerHistory(
            { backend: "claude" } as AgentAdapter,
            {
                backend: "claude",
                sessionId,
                title: "Legacy",
                model: "claude-opus-5",
                reasoning: "high",
            },
            (message) => emitted.push(message),
        );
        assert.deepEqual(emitted, [
            {
                type: "history",
                messages: [
                    {
                        role: "assistant",
                        text: "Legacy reply",
                        model: "claude-opus-5",
                        reasoning: "high",
                    },
                ],
                replace: true,
            },
        ]);
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(root, { recursive: true, force: true });
    }
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
    const transport = readFileSync("src/ahp/messagePortTransport.ts", "utf8");
    const router = readFileSync("src/ahp/clientActionRouter.ts", "utf8");
    const session = readFileSync("src/adapters/openai/session.ts", "utf8");

    assert.match(protocol, /type:\s*["']continue["']/);
    assert.match(transport, /case\s*["']continue["'][\s\S]*?chat\/continuationRequested/);
    assert.match(router, /chat\/continuationRequested[\s\S]*?api\.sessions\.continue/);
    assert.match(session, /continueTurn\(\):\s*void\s*\{[\s\S]*?void this\.runner\.run\(\)/);
    assert.match(session, /pendingResumeTurnId\s*=\s*this\.currentLogicalTurnId/);
    assert.doesNotMatch(session, /continueTurn\(\):[\s\S]*?this\.messages\.push/);
});
