import assert from "node:assert/strict";
import test from "node:test";
import { historyTurns } from "../ahp/historyProjection";
import { toolDisplayMetadata } from "../ahp/toolMetadata";
import { replayRows } from "../application/controllerTranscript";

test("render-log replay keeps tool-only terminal activity in chronological order", () => {
    assert.deepEqual(
        replayRows([
            { type: "user", text: "Inspect the project", ts: 100 },
            {
                type: "event",
                event: { kind: "turn-start", logicalTurnId: "turn-1" },
            },
            {
                type: "event",
                event: {
                    kind: "tool-start",
                    toolName: "read_file",
                    toolId: "tool-1",
                    detail: "/workspace/README.md",
                    input: '{"path":"/workspace/README.md"}',
                    path: "/workspace/README.md",
                    added: 2,
                    removed: 1,
                    todos: [{ content: "Inspect", status: "in_progress" }],
                    diff: [{ old: "before", new: "after" }],
                },
            },
            {
                type: "event",
                event: { kind: "tool-output", toolId: "tool-1", text: "streamed " },
            },
            {
                type: "event",
                event: { kind: "tool-output", toolId: "tool-1", text: "result" },
            },
            {
                type: "event",
                event: {
                    kind: "tool-end",
                    toolName: "read_file",
                    toolId: "tool-1",
                    result: "complete result",
                },
            },
            {
                type: "event",
                event: {
                    kind: "status-notice",
                    severity: "warning",
                    terminal: true,
                    text: "Stopped after repeated tool calls.",
                },
            },
            { type: "event", event: { kind: "turn-end" } },
        ]),
        [
            { role: "user", text: "Inspect the project", ts: 100 },
            {
                role: "tool",
                text: "read_file",
                toolName: "read_file",
                detail: "/workspace/README.md",
                input: '{"path":"/workspace/README.md"}',
                result: "complete result",
                path: "/workspace/README.md",
                added: 2,
                removed: 1,
                todos: [{ content: "Inspect", status: "in_progress" }],
                diff: [{ old: "before", new: "after" }],
            },
            {
                role: "status-notice",
                text: "Stopped after repeated tool calls.",
                severity: "warning",
            },
        ],
    );
});

test("AHP history carries restored tool display metadata to the existing renderer", () => {
    const [turn] = historyTurns([
        { role: "user", text: "Edit the file" },
        {
            role: "tool",
            text: "apply_patch",
            toolName: "apply_patch",
            detail: "/workspace/app.ts",
            input: "patch input",
            result: "done",
            path: "/workspace/app.ts",
            added: 2,
            removed: 1,
            diff: [{ old: "before", new: "after" }],
        },
    ]);
    const part = turn.responseParts[0] as unknown as {
        toolCall: { _meta?: unknown };
    };

    assert.deepEqual(toolDisplayMetadata(part.toolCall._meta), {
        path: "/workspace/app.ts",
        added: 2,
        removed: 1,
        diff: [{ old: "before", new: "after" }],
    });
});
