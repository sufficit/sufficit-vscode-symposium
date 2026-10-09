import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildOutboundPrompt,
    SESSION_SCOPE_PREAMBLE,
    sessionIdNote,
    type BuildOutboundPromptOptions,
} from "../application/outboundPrompt";
import { AI_TOOLS } from "../adapters/aiTools/defs";

const BASE: BuildOutboundPromptOptions = {
    text: "What pending tasks do we have?",
    fileAttachments: [],
    policyInjected: true,
    todoInjected: true,
    seedInjected: true,
    autonomyInjected: false,
};

test("session-scope preamble is injected once when the session id is known", () => {
    const first = buildOutboundPrompt({
        ...BASE,
        sessionId: "11111111-2222-4333-8444-555555555555",
    });
    assert.ok(first.text.includes("[Session scope — IMPORTANT]"));
    assert.ok(first.text.includes(SESSION_SCOPE_PREAMBLE));
    assert.ok(first.text.includes("list_tasks"));
    assert.ok(first.text.includes("read_session(id)"));
    assert.equal(first.state.sessionScopeInjected, true);

    const second = buildOutboundPrompt({
        text: "Continue",
        fileAttachments: [],
        ...first.state,
        sessionId: "11111111-2222-4333-8444-555555555555",
    });
    assert.equal(second.text.includes(SESSION_SCOPE_PREAMBLE), false);

    // No session id → the boundary rule is meaningless, never injected.
    const anonymous = buildOutboundPrompt({ ...BASE });
    assert.equal(anonymous.text.includes(SESSION_SCOPE_PREAMBLE), false);
    assert.equal(anonymous.state.sessionScopeInjected, false);
});

test("session id note warns that foreign sessionIds belong to other conversations", () => {
    const note = sessionIdNote("11111111-2222-4333-8444-555555555555");
    assert.ok(note.includes("[session: 11111111-2222-4333-8444-555555555555]"));
    assert.match(note, /OTHER conversations/i);
    assert.match(note, /never mix/i);
});

test("memory_search description declares global scope; list_tasks is the session-scoped source", () => {
    const byName = new Map(AI_TOOLS.map((t) => [t.function.name, t.function.description]));
    const search = byName.get("memory_search") ?? "";
    assert.match(search, /GLOBAL/i);
    assert.match(search, /otherSession/);
    assert.match(search, /list_tasks/);

    const list = byName.get("list_tasks") ?? "";
    assert.match(list, /session-scoped/i);
    assert.match(list, /memory_search is global/i);
});
