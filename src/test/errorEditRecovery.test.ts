import assert from "node:assert/strict";
import { test } from "node:test";
import { clearFailedAttemptForEdit, FailedAttemptElement } from "../ui/webview/errorEditRecovery";

function element(text: string, meta = false): FailedAttemptElement & { removed: boolean } {
    return {
        nextElementSibling: null,
        textContent: text,
        classList: { contains: (name) => meta && name === "meta" },
        removed: false,
        remove() {
            this.removed = true;
        },
    };
}

test("editing a failed turn removes its error and duration but preserves the prompt row", () => {
    const error = element("HTTP 403 Forbidden");
    const duration = element("— 21.8s —", true);
    error.nextElementSibling = duration;

    clearFailedAttemptForEdit(error);

    assert.equal(error.removed, true);
    assert.equal(duration.removed, true);
});
