import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeTaskTracker } from "../adapters/claude/tasks";
import { parseTranscriptLine } from "../adapters/claude/transcript";

test("Claude native task tracker reconciles TaskCreate and TaskUpdate", () => {
    const tracker = new ClaudeTaskTracker();

    assert.deepEqual(
        tracker.observeToolUse("TaskCreate", { subject: "Inspect the controller" }, "create-1"),
        [{ content: "Inspect the controller", status: "pending", order: 1 }],
    );
    assert.deepEqual(
        tracker.observeToolResult("create-1", {
            task: { id: "2", subject: "Inspect the controller" },
        }),
        [{ content: "Inspect the controller", status: "pending", order: 1 }],
    );
    assert.deepEqual(
        tracker.observeToolUse("TaskUpdate", { taskId: "2", status: "in_progress" }, "update-1"),
        [{ content: "Inspect the controller", status: "in_progress", order: 1 }],
    );
    assert.deepEqual(
        tracker.observeToolUse("TaskUpdate", { taskId: "2", status: "completed" }, "update-2"),
        [{ content: "Inspect the controller", status: "completed", order: 1 }],
    );
    assert.deepEqual(
        tracker.observeToolUse("TaskUpdate", { taskId: "2", status: "deleted" }, "update-3"),
        [],
    );
});

test("Claude transcript parser restores current native task state", () => {
    const tracker = new ClaudeTaskTracker();
    const created = parseTranscriptLine(
        JSON.stringify({
            type: "assistant",
            message: {
                content: [
                    {
                        type: "tool_use",
                        id: "tool-create",
                        name: "TaskCreate",
                        input: { subject: "Run regression" },
                    },
                ],
            },
        }),
        tracker,
    );
    assert.deepEqual(created[0]?.todos, [
        { content: "Run regression", status: "pending", order: 1 },
    ]);

    const createdResult = parseTranscriptLine(
        JSON.stringify({
            type: "user",
            toolUseResult: { task: { id: "7", subject: "Run regression" } },
            message: {
                content: [
                    { type: "tool_result", tool_use_id: "tool-create", content: "Task #7 created" },
                ],
            },
        }),
        tracker,
    );
    assert.deepEqual(createdResult[0]?.todos, [
        { content: "Run regression", status: "pending", order: 1 },
    ]);

    const updated = parseTranscriptLine(
        JSON.stringify({
            type: "assistant",
            message: {
                content: [
                    {
                        type: "tool_use",
                        id: "tool-update",
                        name: "TaskUpdate",
                        input: { taskId: "7", status: "in_progress" },
                    },
                ],
            },
        }),
        tracker,
    );
    assert.deepEqual(updated[0]?.todos, [
        { content: "Run regression", status: "in_progress", order: 1 },
    ]);
});
