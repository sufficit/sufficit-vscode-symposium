import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNativeTodos, parseTodoFence } from "../adapters/todos";

test("parseNativeTodos: Claude TodoWrite", () => {
    const out = parseNativeTodos("TodoWrite", {
        todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c" }],
    });
    assert.deepEqual(out, [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
    ]);
});

test("parseNativeTodos: Codex update_plan with steps + status spellings", () => {
    const out = parseNativeTodos("update_plan", { plan: [{ step: "x", status: "done" }, { step: "y", state: "doing" }] });
    assert.deepEqual(out, [{ content: "x", status: "completed" }, { content: "y", status: "in_progress" }]);
});

test("parseNativeTodos: non-todo tool → undefined", () => {
    assert.equal(parseNativeTodos("Edit", { file_path: "/a" }), undefined);
});

test("parseTodoFence: checkbox block", () => {
    const md = "before\n```todo\n- [x] done\n- [-] doing\n- [ ] todo\n```\nafter";
    assert.deepEqual(parseTodoFence(md), [
        { content: "done", status: "completed" },
        { content: "doing", status: "in_progress" },
        { content: "todo", status: "pending" },
    ]);
});

test("parseTodoFence: no block → undefined", () => {
    assert.equal(parseTodoFence("just text"), undefined);
});


test("parseTodoFence: ordered checkbox block keeps order numbers", () => {
    const md = "```todo\n1. [ ] first\n2. [-] second\n3. [x] third\n```";
    assert.deepEqual(parseTodoFence(md), [
        { content: "first", status: "pending", order: 1 },
        { content: "second", status: "in_progress", order: 2 },
        { content: "third", status: "completed", order: 3 },
    ]);
});
