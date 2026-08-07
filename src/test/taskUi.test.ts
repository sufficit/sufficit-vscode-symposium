import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskItem } from "../sync/tasks";
import {
    applyTaskState,
    completedTaskIds,
    reconcileTaskStateOverrides,
    TaskStateOverride,
} from "../sync/taskUi";

const pending = (id: string): TaskItem => ({
    id,
    type: "task-anchor",
    title: id,
    summary: id,
    done: false,
});

test("task completion result exposes exact completed and cascaded ids to the UI", () => {
    assert.deepEqual(
        completedTaskIds({
            ok: true,
            completed: ["task-current", "task-prior", "task-current", 123],
        }),
        ["task-current", "task-prior"],
    );
    assert.deepEqual(completedTaskIds({ ok: true, pending: [] }), []);
});

test("task completion marks the matching cached row immediately", () => {
    const items = applyTaskState([pending("a"), pending("b")], ["a"], true);

    assert.equal(items[0].done, true);
    assert.equal(items[1].done, false);
});

test("stale search results cannot revert a recent completion to pending", () => {
    const overrides = new Map<string, TaskStateOverride>([["a", { done: true, at: 1_000 }]]);
    const items = reconcileTaskStateOverrides([pending("a")], overrides, 2_000, 60_000);

    assert.equal(items[0].done, true);
    assert.equal(overrides.has("a"), true);
});

test("canonical confirmation clears the local task-state override", () => {
    const overrides = new Map<string, TaskStateOverride>([["a", { done: true, at: 1_000 }]]);
    const done = { ...pending("a"), done: true };
    const items = reconcileTaskStateOverrides([done], overrides, 2_000, 60_000);

    assert.equal(items[0].done, true);
    assert.equal(overrides.has("a"), false);
});

test("task-state override expires if canonical storage never confirms it", () => {
    const overrides = new Map<string, TaskStateOverride>([["a", { done: true, at: 1_000 }]]);
    const items = reconcileTaskStateOverrides([pending("a")], overrides, 61_000, 60_000);

    assert.equal(items[0].done, false);
    assert.equal(overrides.has("a"), false);
});
