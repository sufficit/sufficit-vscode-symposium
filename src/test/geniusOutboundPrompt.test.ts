import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchOutbound } from "../application/controllerDispatchPrompt";
import { AGENT_ROLE_PREAMBLE } from "../application/outboundPrompt";

test("Genius keeps user messages clean and reapplies developer guidance on resume", () => {
    const context = {
        adapter: { backend: "genius", roleAware: () => true },
        sessionId: "11111111-2222-4333-8444-555555555555",
        options: { bootstrap: "Workspace policy", seedHistory: "Previous conversation summary" },
        hubState: { guardrails: [] },
        aiToolsInfo: () => undefined,
        pendingTasksSummary: () => undefined,
        promptState: {
            policyInjected: false,
            todoInjected: false,
            seedInjected: false,
            autonomyInjected: false,
        },
        configuration: { get: () => "", language: "en" },
    } as any;
    const message = { text: "Actual user request", attachments: [] } as any;

    const first = buildDispatchOutbound(context, message);
    assert.equal(first.text, "Actual user request");
    assert.ok(first.preamble.includes(AGENT_ROLE_PREAMBLE));
    assert.ok(first.preamble.some((item) => item.includes("Workspace policy")));

    const second = buildDispatchOutbound(context, { ...message, text: "Continue" });
    assert.equal(second.text, "Continue");
    assert.ok(second.preamble.includes(AGENT_ROLE_PREAMBLE));
    assert.ok(second.preamble.some((item) => item.includes("Previous conversation summary")));
});
