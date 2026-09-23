import assert from "node:assert/strict";
import test from "node:test";
import { createProjectionState, projectAgentEvent } from "../ahp";
import { historyTurns } from "../ahp/historyProjection";

test("an explicitly visible wait notice appears in live and reopened AHP chat", () => {
    const notice = "Sufficit AI has not responded for over 30 seconds.";
    const state = createProjectionState();
    projectAgentEvent(state, { kind: "turn-start", logicalTurnId: "turn-1" });
    const actions = projectAgentEvent(state, {
        kind: "status-notice",
        text: notice,
        transcript: true,
    });
    const response = actions.find((action) => action.action.type === "chat/responsePart");
    assert.ok(response, "the live chat receives a durable response part");
    const part = response.action.part as { kind: string; content: string; _meta: unknown };
    assert.deepEqual(
        { kind: part.kind, content: part.content, _meta: part._meta },
        { kind: "notice", content: notice, _meta: { severity: "info" } },
    );

    const [reopened] = historyTurns([
        { role: "user", text: "Work" },
        { role: "status-notice", text: notice, severity: "info" },
        { role: "assistant", text: "Done" },
    ]);
    const reopenedParts = reopened.responseParts as unknown as Array<{
        kind: string;
        content?: string;
        _meta?: unknown;
    }>;
    assert.deepEqual(
        reopenedParts.map(({ kind, content }) => ({ kind, content })),
        [
            { kind: "notice", content: notice },
            { kind: "markdown", content: "Done" },
        ],
    );
    assert.deepEqual(reopenedParts[0]._meta, { severity: "info" });
});
