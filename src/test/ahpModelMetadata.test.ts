import assert from "node:assert/strict";
import test from "node:test";
import { createProjectionState, projectAgentEvent } from "../ahp";

test("AHP carries a model announced before text into live and usage metadata", () => {
    const state = createProjectionState();
    const actions = [
        ...projectAgentEvent(state, {
            kind: "session",
            sessionId: "claude-session",
            model: "claude-opus-5",
        }),
        ...projectAgentEvent(state, { kind: "turn-start", logicalTurnId: "model-turn" }),
        ...projectAgentEvent(state, { kind: "text", text: "modelled reply" }),
        ...projectAgentEvent(state, {
            kind: "usage",
            inputTokens: 10,
            outputTokens: 4,
        }),
    ];
    const delta = actions.find((entry) => entry.action.type === "chat/delta");
    const usage = actions.find((entry) => entry.action.type === "chat/usage");
    assert.equal(
        (delta?.action._meta as { symposium?: { model?: string } }).symposium?.model,
        "claude-opus-5",
    );
    assert.equal((usage?.action.usage as { model?: string }).model, "claude-opus-5");
});
