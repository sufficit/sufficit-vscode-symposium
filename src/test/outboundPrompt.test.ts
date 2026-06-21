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

test("buildOutboundPrompt injects workspace bootstrap once, before the first message", () => {
    const first = buildOutboundPrompt({
        text: "Start work",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        bootstrap: "Workspace facts: uses .NET 8 and Galera.",
    });
    assert.ok(first.text.includes("[Workspace bootstrap]"));
    assert.ok(first.text.includes("uses .NET 8 and Galera"));
    assert.equal(first.state.bootstrapInjected, true);

    const second = buildOutboundPrompt({
        text: "Next message",
        fileAttachments: [],
        bootstrap: "Workspace facts: uses .NET 8 and Galera.",
        ...first.state,
    });
    assert.equal(second.text.includes("[Workspace bootstrap]"), false);
});

test("buildOutboundPrompt injects checkpoint discipline once when enabled", () => {
    const first = buildOutboundPrompt({
        text: "Start", fileAttachments: [],
        policyInjected: true, todoInjected: false, seedInjected: false, autonomyInjected: false,
        checkpoints: true,
    });
    assert.ok(first.text.includes("[Context window & checkpoints"));
    assert.equal(first.state.checkpointInjected, true);
    const second = buildOutboundPrompt({
        text: "Next", fileAttachments: [], checkpoints: true, ...first.state,
    });
    assert.equal(second.text.includes("[Context window & checkpoints"), false);
    // Disabled → never injected.
    const off = buildOutboundPrompt({
        text: "x", fileAttachments: [],
        policyInjected: true, todoInjected: false, seedInjected: false, autonomyInjected: false,
    });
    assert.equal(off.text.includes("[Context window & checkpoints"), false);
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

test("buildOutboundPrompt injects current session id note once", () => {
    const first = buildOutboundPrompt({
        text: "Continue from here",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: true,
        seedInjected: true,
        autonomyInjected: false,
        sessionIdInjected: false,
        sessionId: "7abe6ecfeee349208d0171a11ee8fd80",
    });
    assert.match(first.text, /\[session: 7abe6ecfeee349208d0171a11ee8fd80\]/);
    assert.equal(first.state.sessionIdInjected, true);

    const second = buildOutboundPrompt({
        text: "More",
        fileAttachments: [],
        ...first.state,
        sessionId: "7abe6ecfeee349208d0171a11ee8fd80",
    });
    assert.equal(second.text.includes("[session:"), false);
});

test("role-aware backends receive session note as developer preamble, not user text", () => {
    const out = buildOutboundPrompt({
        text: "Investigate",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: true,
        seedInjected: true,
        autonomyInjected: false,
        sessionIdInjected: false,
        sessionId: "54c22186a57a42058de358784ffd192b",
        asRoles: true,
    });
    assert.equal(out.text, "Investigate");
    assert.equal(out.preamble.length, 1);
    assert.match(out.preamble[0], /\[session: 54c22186a57a42058de358784ffd192b\]/);
});
