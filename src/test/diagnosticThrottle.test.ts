import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticThrottle } from "../ahp/diagnosticThrottle";

test("diagnostic throttle suppresses duplicates and rate-limits changed dumps", () => {
    let now = 1_000;
    const throttle = new DiagnosticThrottle(30_000, () => now);

    assert.equal(throttle.shouldEmit("first"), true);
    now += 10_000;
    assert.equal(throttle.shouldEmit("changed"), false);
    now += 20_000;
    assert.equal(throttle.shouldEmit("changed"), true);
    now += 31_000;
    assert.equal(throttle.shouldEmit("changed"), false);
    assert.equal(throttle.shouldEmit("forced", true), true);
});
