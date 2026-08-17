import assert from "node:assert/strict";
import test from "node:test";
import { sessionMetadata } from "../ui/webview/sessionMetadata";

test("session metadata includes adapter, model, effort and relative time", () => {
    const view = sessionMetadata({
        backend: "claude",
        backendName: "Claude",
        model: "claude-opus-5",
        reasoning: "high",
        updatedAt: "2026-08-17T12:00:00.000Z",
        relativeTime: "2m ago",
    });
    assert.equal(view.visible, "Claude · model: claude-opus-5 · effort: high · 2m ago");
    assert.match(view.tooltip, /Adapter: Claude/);
    assert.match(view.tooltip, /Model: claude-opus-5/);
    assert.match(view.tooltip, /Effort: high/);
});

test("session metadata makes missing historical values explicit on hover", () => {
    const view = sessionMetadata({ backend: "codex" });
    assert.match(view.tooltip, /Model: unavailable/);
    assert.match(view.tooltip, /Effort: unavailable/);
});
