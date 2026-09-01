import assert from "node:assert/strict";
import test from "node:test";
import { formatRetryRemaining, retryAvailability } from "../ui/retryAvailability";

test("Retry remains hidden before the provider deadline and becomes available at reset", () => {
    assert.deepEqual(retryAvailability(20_000, 10_000), {
        waiting: true,
        remainingMilliseconds: 10_000,
    });
    assert.deepEqual(retryAvailability(20_000, 20_000), {
        waiting: false,
        remainingMilliseconds: 0,
    });
});

test("Retry countdown uses compact stable durations", () => {
    assert.equal(formatRetryRemaining(3_661_000), "1h 1min");
    assert.equal(formatRetryRemaining(61_000), "1min 1s");
    assert.equal(formatRetryRemaining(900), "1s");
});
