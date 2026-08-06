import assert from "node:assert/strict";
import test from "node:test";
import { FollowStatusRegistry, liveSessionStatus } from "../sessions/status";

test("a failed idle controller is exposed as an error status", () => {
    assert.equal(liveSessionStatus(false, "error"), "error");
});

test("a stopped warning is exposed as a warning status", () => {
    assert.equal(liveSessionStatus(false, "warning"), "warning");
});

test("working takes precedence while a new turn is still running", () => {
    assert.equal(liveSessionStatus(true, "error"), "working");
});

test("an idle controller without a failure remains idle", () => {
    assert.equal(liveSessionStatus(false, undefined), "idle");
});

test("a followed process keeps its last live status until explicitly cleared", () => {
    const statuses = new FollowStatusRegistry();
    statuses.set("session-1", "working");
    assert.equal(statuses.get("session-1"), "working");
    statuses.set("session-1", "idle");
    assert.equal(statuses.get("session-1"), "idle");
    assert.equal(statuses.delete("session-1"), true);
    assert.equal(statuses.get("session-1"), undefined);
});
