import assert from "node:assert/strict";
import test from "node:test";
import {
    markMessageDispatched,
    resetDispatchedMessages,
    wasMessageDispatched,
} from "../ui/webview/dispatchedMessages";

/**
 * The render-layer rule behind the Queued panel: a message the host reported as
 * dispatched is not pending, so it must not be listed.
 */

test("an id the host reported as dispatched is recognised", () => {
    resetDispatchedMessages();
    markMessageDispatched("local-1");
    assert.equal(wasMessageDispatched("local-1"), true);
    assert.equal(wasMessageDispatched("local-2"), false);
});

// Regression: three identical messages queued on purpose must all stay listed.
// A text-based rule collapsed them the moment the first one dispatched.
test("identical texts are distinct messages — only the dispatched id is filtered", () => {
    resetDispatchedMessages();
    const rows = [
        { clientMessageId: "local-a-5", text: "testes" },
        { clientMessageId: "local-b-6", text: "testes" },
        { clientMessageId: "local-c-7", text: "testes" },
    ];

    markMessageDispatched("local-a-5");

    assert.deepEqual(
        rows.filter((row) => !wasMessageDispatched(row.clientMessageId)).map((row) => row.text),
        ["testes", "testes"],
        "the two still queued stay visible",
    );
});

test("a row with no id is never filtered", () => {
    resetDispatchedMessages();
    markMessageDispatched("local-1");
    assert.equal(wasMessageDispatched(undefined), false);
});

test("a session switch forgets the previous dialogue", () => {
    resetDispatchedMessages();
    markMessageDispatched("local-1");
    resetDispatchedMessages();
    assert.equal(wasMessageDispatched("local-1"), false);
});
