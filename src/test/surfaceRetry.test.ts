import assert from "node:assert/strict";
import test from "node:test";
import type { SurfaceMessagesDeps } from "../ui/surfaceMessagesTypes";
import { handleSurfaceRetry } from "../ui/surfaceRetry";

function deps(retryResult = true) {
    const posted: unknown[] = [];
    const retried: unknown[][] = [];
    const value = {
        post: (message: unknown) => posted.push(message),
        dialogues: {
            retryLastMessage: (...args: unknown[]) => {
                retried.push(args);
                return retryResult;
            },
        },
    } as unknown as SurfaceMessagesDeps;
    return { value, posted, retried };
}

test("host rejects a Retry submitted before the provider reset", () => {
    const h = deps();
    handleSurfaceRetry(
        {
            type: "retry-last-message",
            index: 4,
            text: "continue",
            retryAt: Date.now() + 60_000,
        },
        h.value,
    );

    assert.deepEqual(h.retried, []);
    assert.deepEqual(h.posted, [
        {
            type: "toast",
            text: "Retry is not available until the provider limit resets.",
        },
    ]);
});

test("host dispatches Retry once the provider deadline has passed", () => {
    const h = deps();
    handleSurfaceRetry(
        {
            type: "retry-last-message",
            index: 4,
            text: "continue",
            errorMessage: "session limit",
            retryAt: Date.now() - 1,
        },
        h.value,
    );

    assert.deepEqual(h.posted, []);
    assert.deepEqual(h.retried, [[4, "session limit", "continue"]]);
});

test("host rolls back optimistic Retry state when no controller can accept it", () => {
    const h = deps(false);
    handleSurfaceRetry(
        {
            type: "retry-last-message",
            index: 4,
            text: "continue",
            errorMessage: "fetch failed",
        },
        h.value,
    );

    assert.deepEqual(h.posted, [
        { type: "busy", busy: false },
        { type: "toast", text: "Retry could not be started. Reopen the session and try again." },
    ]);
});
