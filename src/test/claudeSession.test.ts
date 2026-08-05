import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClaudeSession } from "../adapters/claude/session";
import { claudeResumeSessionId } from "../adapters/claude/resume";
import type { AgentEvent } from "../adapters/types";

function waitForTurnEnd(session: ClaudeSession): Promise<AgentEvent[]> {
    return new Promise((resolve, reject) => {
        const events: AgentEvent[] = [];
        const timer = setTimeout(() => reject(new Error("timed out waiting for Claude turn-end")), 2000);
        const listener = (event: AgentEvent) => {
            events.push(event);
            if (event.kind === "turn-end") {
                clearTimeout(timer);
                session.off("event", listener);
                resolve(events);
            }
        };
        session.on("event", listener);
    });
}

test("Claude retries spawn after ENOENT instead of reusing the dead child", async () => {
    const session = new ClaudeSession({
        executable: "symposium-test-claude-does-not-exist",
        model: "",
        permissionMode: "plan",
        env: {},
    }, { cwd: process.cwd() });

    try {
        const first = waitForTurnEnd(session);
        session.send("first attempt");
        const firstEvents = await first;

        const second = waitForTurnEnd(session);
        session.send("second attempt");
        const secondEvents = await second;

        for (const events of [firstEvents, secondEvents]) {
            assert.ok(events.some((event) => event.kind === "error" && /ENOENT/.test(event.message)));
            assert.equal(events.at(-1)?.kind, "turn-end");
        }
    } finally {
        session.dispose();
    }
});

test("Claude resumes a listed subagent through its parent conversation UUID", () => {
    assert.equal(
        claudeResumeSessionId("33cce505-8848-4f48-88a5-da7faedcd4f2/subagents/agent-a1bb4e66e2be943da"),
        "33cce505-8848-4f48-88a5-da7faedcd4f2",
    );
});

test("Claude keeps normal session ids and titles unchanged", () => {
    assert.equal(
        claudeResumeSessionId("33cce505-8848-4f48-88a5-da7faedcd4f2"),
        "33cce505-8848-4f48-88a5-da7faedcd4f2",
    );
    assert.equal(claudeResumeSessionId("my named session"), "my named session");
    assert.equal(claudeResumeSessionId("not-a-uuid/subagents/agent-123"), "not-a-uuid/subagents/agent-123");
});

test("Claude treats the interrupted result from steer as a normal turn end", () => {
    const session = new ClaudeSession({ executable: "claude", model: "", permissionMode: "plan", env: {} }, { cwd: process.cwd() });
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));
    const sourceChild = {} as ChildProcessWithoutNullStreams;
    const internals = session as unknown as {
        handleLine(line: string, sourceChild?: ChildProcessWithoutNullStreams): void;
        cancelledChildren: WeakSet<ChildProcessWithoutNullStreams>;
    };
    const receive = internals.handleLine.bind(session);

    internals.cancelledChildren.add(sourceChild);
    receive(JSON.stringify({ type: "result", is_error: true, result: "Request ended before the agent could reply." }), sourceChild);

    assert.equal(events.some((event) => event.kind === "error"), false);
    assert.equal(events.at(-1)?.kind, "turn-end");
    session.dispose();
});

test("Claude emits native TaskCreate/TaskUpdate snapshots for the plan panel", () => {
    const session = new ClaudeSession({ executable: "claude", model: "", permissionMode: "plan", env: {} }, { cwd: process.cwd() });
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));
    const receive = (session as unknown as { handleLine(line: string): void }).handleLine.bind(session);

    receive(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "create-1", name: "TaskCreate", input: { subject: "Inspect Claude task events" } }] },
    }));
    receive(JSON.stringify({
        type: "user",
        toolUseResult: { task: { id: "4", subject: "Inspect Claude task events" } },
        message: { content: [{ type: "tool_result", tool_use_id: "create-1", content: "Task #4 created" }] },
    }));
    receive(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "update-1", name: "TaskUpdate", input: { taskId: "4", status: "in_progress" } }] },
    }));

    const snapshots = events.filter((event): event is Extract<AgentEvent, { kind: "tool-start" }> => event.kind === "tool-start" && !!event.todos);
    assert.deepEqual(snapshots.map((event) => event.todos), [
        [{ content: "Inspect Claude task events", status: "pending", order: 1 }],
        [{ content: "Inspect Claude task events", status: "in_progress", order: 1 }],
    ]);
    session.dispose();
});
