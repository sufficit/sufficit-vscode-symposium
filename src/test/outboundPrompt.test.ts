import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AUTONOMY_PREAMBLE,
    buildOutboundPrompt,
    CANCELED_RETRY_PREAMBLE,
} from "../ui/outboundPrompt";

test("buildOutboundPrompt injects canceled policy once", () => {
    const first = buildOutboundPrompt({
        text: "Fix the issue",
        fileAttachments: [],
        policyInjected: false,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
    });
    assert.match(first.text, /Operational rule/);
    assert.ok(first.text.includes(CANCELED_RETRY_PREAMBLE));
    assert.equal(first.state.policyInjected, true);

    const second = buildOutboundPrompt({
        text: "Continue",
        fileAttachments: [],
        ...first.state,
    });
    assert.equal(second.text.includes(CANCELED_RETRY_PREAMBLE), false);
});

test("buildOutboundPrompt classifies autonomy and attachments", () => {
    const out = buildOutboundPrompt({
        text: "Investigate",
        fileAttachments: ["/tmp/a.txt", "/tmp/b.ts"],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        autonomy: "away",
        todoInjection: "TODO BLOCK",
        seedHistory: "User: previous",
    });
    assert.ok(out.text.includes(AUTONOMY_PREAMBLE));
    assert.ok(out.text.includes("TODO BLOCK"));
    assert.ok(out.text.includes("User: previous"));
    assert.ok(out.text.includes("Attached files (read them from disk):"));
    assert.ok(out.text.includes("- /tmp/a.txt"));
    assert.ok(out.text.includes("- /tmp/b.ts"));
    assert.equal(out.state.autonomyInjected, true);
    assert.equal(out.state.todoInjected, true);
    assert.equal(out.state.seedInjected, true);
});

test("buildOutboundPrompt asRoles returns preambles separately, not glued to text", () => {
    const out = buildOutboundPrompt({
        text: "Investigate",
        fileAttachments: ["/tmp/a.txt"],
        policyInjected: false,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        autonomy: "away",
        todoInjection: "TODO BLOCK",
        asRoles: true,
    });
    // Preambles go to the developer channel...
    assert.ok(out.preamble.includes(CANCELED_RETRY_PREAMBLE));
    assert.ok(out.preamble.includes(AUTONOMY_PREAMBLE));
    assert.ok(out.preamble.includes("TODO BLOCK"));
    // ...and are NOT glued onto the user text (only the attachments note is).
    assert.equal(out.text.includes(CANCELED_RETRY_PREAMBLE), false);
    assert.equal(out.text.includes("TODO BLOCK"), false);
    assert.ok(out.text.includes("Attached files (read them from disk):"));
});

test("buildOutboundPrompt resets autonomy flag when user returns", () => {
    const out = buildOutboundPrompt({
        text: "Back again",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: true,
        seedInjected: true,
        autonomyInjected: true,
        autonomy: "present",
    });
    assert.equal(out.text.includes(AUTONOMY_PREAMBLE), false);
    assert.equal(out.state.autonomyInjected, false);
});
