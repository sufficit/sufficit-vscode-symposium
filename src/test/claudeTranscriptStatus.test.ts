import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    parseTranscriptLine,
    rawLineActivity,
    readSessionMeta,
} from "../adapters/claude/transcript";

test("Claude transcript activity recognizes current end_turn boundaries", () => {
    assert.equal(
        rawLineActivity(JSON.stringify({ type: "user", message: { content: "continue" } })),
        "working",
    );
    assert.equal(
        rawLineActivity(
            JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use" } }),
        ),
        "working",
    );
    assert.equal(
        rawLineActivity(
            JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn" } }),
        ),
        "idle",
    );
});

test("Claude transcript activity keeps legacy result support and ignores metadata", () => {
    assert.equal(rawLineActivity(JSON.stringify({ type: "result" })), "idle");
    assert.equal(
        rawLineActivity(JSON.stringify({ type: "user", isMeta: true, message: {} })),
        undefined,
    );
    assert.equal(rawLineActivity("not-json"), undefined);
});

test("Claude session metadata exposes the model and recorded effort when present", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-claude-meta-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
        file,
        [
            {
                type: "user",
                cwd: "/workspace",
                gitBranch: "develop",
                message: { content: "Inspect" },
            },
            { type: "assistant", message: { model: "claude-opus-5", effort: "high" } },
        ]
            .map((row) => JSON.stringify(row))
            .join("\n"),
    );
    const meta = await readSessionMeta(file);
    assert.equal(meta.model, "claude-opus-5");
    assert.equal(meta.reasoning, "high");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("Claude history keeps model and effort on each assistant message", () => {
    const messages = parseTranscriptLine(
        JSON.stringify({
            type: "assistant",
            timestamp: "2026-08-18T12:00:00.000Z",
            message: {
                model: "claude-opus-5",
                effort: "high",
                content: [{ type: "text", text: "Finished the task." }],
            },
        }),
    );
    assert.deepEqual(messages, [
        {
            role: "assistant",
            text: "Finished the task.",
            model: "claude-opus-5",
            reasoning: "high",
            ts: Date.parse("2026-08-18T12:00:00.000Z"),
        },
    ]);
});

test("Claude history preserves the hard-limit reset used to gate Retry", () => {
    const messages = parseTranscriptLine(
        JSON.stringify({
            type: "result",
            is_error: true,
            timestamp: "2026-07-22T15:00:00.000Z",
            result: "You've hit your session limit · resets 2:30pm (America/Sao_Paulo)",
        }),
    );

    assert.deepEqual(messages, [
        {
            role: "error",
            text: "You've hit your session limit · resets 2:30pm (America/Sao_Paulo)",
            retryable: true,
            retryAt: Date.parse("2026-07-22T17:30:00.000Z"),
            ts: Date.parse("2026-07-22T15:00:00.000Z"),
        },
    ]);
});
