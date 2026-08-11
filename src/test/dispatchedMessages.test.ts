import assert from "node:assert/strict";
import test from "node:test";
import {
    markMessageDispatched,
    resetDispatchedMessages,
    wasMessageDispatched,
} from "../ui/webview/dispatchedMessages";

/**
 * The render-layer rule behind the Queued panel: a message the host reported as
 * dispatched is not pending, so it must not be listed. Ten releases fixed one
 * producer of the ghost row at a time; this is the guard that does not care
 * which producer created it.
 */

test("an id the host reported as dispatched is recognised", () => {
    resetDispatchedMessages();
    markMessageDispatched("local-1", "hello");
    assert.equal(wasMessageDispatched("local-1"), true);
    assert.equal(wasMessageDispatched("local-2"), false);
});

test("the text alone is enough when the ids do not line up", () => {
    resetDispatchedMessages();
    // Every producer mints its own id — the AHP transport falls back to a
    // generated one, the host queue projection uses the queue item's id — so a
    // row can carry an id the transcript never saw. The text is the one thing
    // they agree on.
    markMessageDispatched("host-side-id", "o symposium possui api");
    assert.equal(wasMessageDispatched("transport-side-id", "o symposium possui api"), true);
});

test("an unrelated queued message is still pending", () => {
    resetDispatchedMessages();
    markMessageDispatched("local-1", "already sent");
    assert.equal(wasMessageDispatched("local-9", "genuinely waiting"), false);
});

test("a session switch forgets the previous dialogue", () => {
    resetDispatchedMessages();
    markMessageDispatched("local-1", "hello");
    resetDispatchedMessages();
    assert.equal(wasMessageDispatched("local-1", "hello"), false);
});

test("the text history is bounded and keeps the most recent entries", () => {
    resetDispatchedMessages();
    for (let index = 0; index < 60; index++) {
        markMessageDispatched(undefined, `message ${index}`);
    }
    assert.equal(wasMessageDispatched(undefined, "message 59"), true);
    assert.equal(wasMessageDispatched(undefined, "message 0"), false, "oldest entries evicted");
});

test("repeating the same text does not consume extra history", () => {
    resetDispatchedMessages();
    for (let index = 0; index < 60; index++) {
        markMessageDispatched(undefined, "same text");
    }
    markMessageDispatched(undefined, "other text");
    assert.equal(wasMessageDispatched(undefined, "same text"), true);
    assert.equal(wasMessageDispatched(undefined, "other text"), true);
});
