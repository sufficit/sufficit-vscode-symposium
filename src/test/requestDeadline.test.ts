import assert from "node:assert/strict";
import test from "node:test";
import { withAbortableDeadline } from "../sync/requestDeadline";

test("request deadline releases a caller and aborts a stalled operation", async () => {
    let observedSignal: AbortSignal | undefined;
    const stalled = withAbortableDeadline("Hub test", 20, async (signal) => {
        observedSignal = signal;
        return await new Promise<string>(() => undefined);
    });

    await assert.rejects(stalled, /Hub test timed out after 20 ms/);
    assert.equal(observedSignal?.aborted, true);
});

test("request deadline preserves a successful result without aborting", async () => {
    let observedSignal: AbortSignal | undefined;
    const value = await withAbortableDeadline("Hub test", 1_000, (signal) => {
        observedSignal = signal;
        return Promise.resolve("ok");
    });

    assert.equal(value, "ok");
    assert.equal(observedSignal?.aborted, false);
});
