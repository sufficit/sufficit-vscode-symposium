import { test } from "node:test";
import assert from "node:assert/strict";
import {
    canonicalReasoning,
    nativeReasoning,
    REASONING_MAPS,
    SYMPOSIUM_REASONING_LEVELS,
} from "../adapters/reasoning";

test("each adapter maps the shared Symposium reasoning vocabulary to native levels", () => {
    assert.deepEqual(SYMPOSIUM_REASONING_LEVELS, ["minimal", "low", "medium", "high", "xhigh"]);
    assert.deepEqual(Object.keys(REASONING_MAPS.claude), ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(Object.keys(REASONING_MAPS.codex), [...SYMPOSIUM_REASONING_LEVELS]);
    assert.deepEqual(Object.keys(REASONING_MAPS.copilot), ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(Object.keys(REASONING_MAPS.openai), [...SYMPOSIUM_REASONING_LEVELS]);
    assert.equal(nativeReasoning(REASONING_MAPS.codex, "xhigh"), "xhigh");
    assert.equal(nativeReasoning(REASONING_MAPS.claude, "minimal"), "default");
    assert.equal(canonicalReasoning(REASONING_MAPS.claude, "max"), "xhigh");
});
