import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AUTONOMY_PREAMBLE,
    buildOutboundPrompt,
    CANCELED_RETRY_PREAMBLE,
    EXECUTION_CONTINUITY_PREAMBLE,
    handoffReferenceNote,
    SHELL_EXECUTION_PREAMBLE,
    planTrackingPreamble,
    responseLanguageName,
    responseLanguagePreamble,
} from "../application/outboundPrompt";

test("response language is reasserted on every turn, including resumed sessions", () => {
    assert.equal(responseLanguageName("en-US"), "English");
    assert.equal(responseLanguageName("pt-BR"), "Portuguese (Brazil)");
    const first = buildOutboundPrompt({
        text: "Investigate",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: true,
        seedInjected: true,
        autonomyInjected: false,
        responseLanguage: responseLanguageName("en-US"),
    });
    assert.ok(first.text.includes(responseLanguagePreamble("English")));
    const second = buildOutboundPrompt({
        text: "Continue",
        fileAttachments: [],
        ...first.state,
        responseLanguage: responseLanguageName("en-US"),
    });
    assert.ok(second.text.includes(responseLanguagePreamble("English")));
});

test("buildOutboundPrompt keeps native shell guidance on every turn", () => {
    const first = buildOutboundPrompt({
        text: "Collect diagnostics",
        fileAttachments: [],
        policyInjected: false,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
    });
    assert.ok(first.text.includes(SHELL_EXECUTION_PREAMBLE));
    assert.ok(first.text.includes(EXECUTION_CONTINUITY_PREAMBLE));

    const second = buildOutboundPrompt({ text: "Continue", fileAttachments: [], ...first.state });
    assert.ok(second.text.includes(SHELL_EXECUTION_PREAMBLE));
    assert.ok(second.text.includes(EXECUTION_CONTINUITY_PREAMBLE));
});

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
        text: "Start",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        checkpoints: true,
    });
    assert.ok(first.text.includes("[Context window & checkpoints"));
    // Checkpoint preamble is now ONLY about context-window/checkpoint memory;
    // the plan/tracking instruction lives in its own preamble.
    assert.equal(first.text.includes("add_task"), false);
    assert.equal(first.state.checkpointInjected, true);
    const second = buildOutboundPrompt({
        text: "Next",
        fileAttachments: [],
        checkpoints: true,
        ...first.state,
    });
    assert.equal(second.text.includes("[Context window & checkpoints"), false);
    // Disabled → never injected.
    const off = buildOutboundPrompt({
        text: "x",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
    });
    assert.equal(off.text.includes("[Context window & checkpoints"), false);
});

test("buildOutboundPrompt injects plan/tracking discipline for every backend", () => {
    // Native (CLI with TodoWrite/update_plan) — even without checkpoints/roleAware.
    const native = buildOutboundPrompt({
        text: "Do it",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        trackingMode: "native",
    });
    assert.ok(native.text.includes("[PLAN & TRACK TASKS"));
    assert.ok(native.text.includes("TodoWrite"));
    assert.equal(native.text.includes("add_task"), false);
    assert.equal(native.state.trackingInjected, true);

    // hub-tools (OpenAI w/ Hub) — mentions add_task/task_complete.
    const hub = buildOutboundPrompt({
        text: "Do it",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        trackingMode: "hub-tools",
    });
    assert.ok(hub.text.includes("add_task"));
    assert.ok(hub.text.includes("task_complete"));
    assert.equal(hub.state.trackingInjected, true);

    // fence mode is owned by todoInjection, so trackingMode: "fence" is NOT
    // injected here (avoids restating the ```todo instruction twice).
    const fence = buildOutboundPrompt({
        text: "Do it",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        trackingMode: "fence",
    });
    assert.equal(fence.text.includes("[PLAN & TRACK TASKS"), false);
    assert.equal(fence.state.trackingInjected, false);

    // Injected once: second call with propagated state does not re-inject.
    const nativeSecond = buildOutboundPrompt({
        text: "More",
        fileAttachments: [],
        trackingMode: "native",
        ...native.state,
    });
    assert.equal(nativeSecond.text.includes("[PLAN & TRACK TASKS"), false);
});

test("planTrackingPreamble adapts wording to the backend capability", () => {
    const hub = planTrackingPreamble("hub-tools");
    const native = planTrackingPreamble("native");
    const fence = planTrackingPreamble("fence");
    // Common head present in all three.
    assert.ok(hub.startsWith("[PLAN & TRACK TASKS"));
    assert.ok(native.startsWith("[PLAN & TRACK TASKS"));
    assert.ok(fence.startsWith("[PLAN & TRACK TASKS"));
    // Backend-specific tails.
    assert.ok(hub.includes("add_task"));
    assert.ok(native.includes("TodoWrite"));
    assert.ok(fence.includes("```todo"));
});

test("buildOutboundPrompt prepends resume checkpoint when provided", () => {
    const out = buildOutboundPrompt({
        text: "continue",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
        resumeCheckpoint: "[Resume] latest checkpoint: did X, next Y",
    });
    assert.ok(out.text.includes("[Resume] latest checkpoint: did X, next Y"));
    // None provided → not present.
    const none = buildOutboundPrompt({
        text: "continue",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: false,
        seedInjected: false,
        autonomyInjected: false,
    });
    assert.equal(none.text.includes("[Resume]"), false);
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

test("backend handoff injects only a parent reference, not the full transcript", () => {
    const handoff = {
        sessionId: "claude-parent-123",
        backend: "Claude Code",
        title: "Fix bridge routing",
    };
    const out = buildOutboundPrompt({
        text: "Continue the parent conversation.",
        fileAttachments: [],
        policyInjected: true,
        todoInjected: true,
        seedInjected: false,
        autonomyInjected: false,
        handoff,
    });
    assert.ok(out.text.includes("claude-parent-123"));
    assert.ok(out.text.includes("read_session"));
    assert.ok(out.text.includes("Fix bridge routing"));
    assert.equal(out.text.includes("[user] full historic transcript"), false);
    assert.equal(out.state.handoffInjected, true);

    const second = buildOutboundPrompt({
        text: "next turn",
        fileAttachments: [],
        ...out.state,
        handoff,
    });
    assert.equal(second.text.includes("claude-parent-123"), false);
});

test("backend handoff degrades safely when the source id is unavailable", () => {
    const note = handoffReferenceNote({ backend: "Claude Code", title: "Untitled" });
    assert.ok(note.includes("not available"));
    assert.equal(note.includes("read_session with this id"), false);
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
    assert.ok(out.preamble.includes(SHELL_EXECUTION_PREAMBLE));
    assert.ok(out.preamble.some((p) => /\[session: 54c22186a57a42058de358784ffd192b\]/.test(p)));
});
