import assert from "node:assert/strict";
import test from "node:test";
import { liveSessionStatus } from "../sessions/status";

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
