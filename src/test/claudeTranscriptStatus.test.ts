import assert from "node:assert/strict";
import test from "node:test";
import { rawLineActivity } from "../adapters/claude/transcript";

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
