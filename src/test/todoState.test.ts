import assert from "node:assert/strict";
import test from "node:test";
import { latestTodoSnapshot, todoSnapshotFromRenderMessage } from "../application/todoState";

const plan = [
    { content: "Alterar o arquivo", status: "in_progress" as const, order: 1 },
    { content: "Validar no disco", status: "pending" as const, order: 2 },
];

test("task state hydrates from live event envelopes", () => {
    assert.deepEqual(
        todoSnapshotFromRenderMessage({
            type: "event",
            event: { kind: "tool-start", todos: plan },
        }),
        plan,
    );
});

test("task state hydrates from the newest restored history snapshot", () => {
    assert.deepEqual(
        latestTodoSnapshot([
            { role: "tool", text: "TodoWrite", todos: [{ content: "antigo", status: "pending" }] },
            { role: "tool", text: "TodoWrite", todos: plan },
        ]),
        plan,
    );
});

test("an empty snapshot is authoritative when every native task is complete", () => {
    assert.deepEqual(
        latestTodoSnapshot([
            { type: "event", event: { kind: "tool-start", todos: plan } },
            { type: "event", event: { kind: "tool-start", todos: [] } },
        ]),
        [],
    );
});

test("malformed task snapshots are ignored instead of erasing prompt state", () => {
    assert.equal(
        todoSnapshotFromRenderMessage({
            type: "event",
            event: { kind: "tool-start", todos: [{ content: "missing status" }] },
        }),
        undefined,
    );
});
