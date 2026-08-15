import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeSession } from "../adapters/claude/session";
import { ClaudeSessionCoordination } from "../adapters/claude/sessionCoordination";
import { claudeResumeSessionId } from "../adapters/claude/resume";
import type { AgentEvent } from "../adapters/types";

function waitForTurnEnd(session: ClaudeSession): Promise<AgentEvent[]> {
    return new Promise((resolve, reject) => {
        const events: AgentEvent[] = [];
        const timer = setTimeout(
            () => reject(new Error("timed out waiting for Claude turn-end")),
            2000,
        );
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
    const session = new ClaudeSession(
        {
            executable: "symposium-test-claude-does-not-exist",
            model: "",
            permissionMode: "plan",
            env: {},
        },
        { cwd: process.cwd() },
    );

    try {
        const first = waitForTurnEnd(session);
        session.send("first attempt", undefined, undefined, "intent-1");
        const firstEvents = await first;

        const second = waitForTurnEnd(session);
        session.send("second attempt", undefined, undefined, "intent-2");
        const secondEvents = await second;

        for (const [index, events] of [firstEvents, secondEvents].entries()) {
            assert.deepEqual(events[0], {
                kind: "turn-start",
                logicalTurnId: `claude/turn-${index + 1}`,
                intentId: `intent-${index + 1}`,
            });
            assert.ok(
                events.some((event) => event.kind === "error" && /ENOENT/.test(event.message)),
            );
            assert.equal(events.at(-1)?.kind, "turn-end");
        }
    } finally {
        session.dispose();
    }
});

test("Claude applies a model picker change to the next turn in the same conversation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symposium-claude-model-"));
    const executable = path.join(dir, "fake-claude.cjs");
    const argsLog = path.join(dir, "args.jsonl");
    await fs.writeFile(
        executable,
        `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const log = process.env.SYMPOSIUM_CLAUDE_ARGS;
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "default";
const sessionId = "fake-claude-model-session";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", () => {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text: "ok" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\\n");
});
`,
        { mode: 0o755 },
    );

    const session = new ClaudeSession(
        {
            executable,
            model: "model-a",
            permissionMode: "plan",
            env: { SYMPOSIUM_CLAUDE_ARGS: argsLog },
        },
        { cwd: process.cwd(), model: "model-a" },
    );

    try {
        const first = waitForTurnEnd(session);
        session.send("first turn");
        await first;

        session.setModel("model-b");
        assert.equal(session.getModel(), "model-b");

        const second = waitForTurnEnd(session);
        session.send("second turn");
        await second;

        const launches = (await fs.readFile(argsLog, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[]);
        assert.equal(launches.length, 2);
        assert.deepEqual(
            launches[0].slice(launches[0].indexOf("--model"), launches[0].indexOf("--model") + 2),
            ["--model", "model-a"],
        );
        assert.deepEqual(
            launches[1].slice(launches[1].indexOf("--model"), launches[1].indexOf("--model") + 2),
            ["--model", "model-b"],
        );
        assert.deepEqual(
            launches[1].slice(launches[1].indexOf("--resume"), launches[1].indexOf("--resume") + 2),
            ["--resume", "fake-claude-model-session"],
        );
    } finally {
        session.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("Claude serializes resumed turns across code-server windows and refreshes stale context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symposium-claude-windows-"));
    const executable = path.join(dir, "fake-claude.cjs");
    const argsLog = path.join(dir, "args.jsonl");
    const coordinationRoot = path.join(dir, "coordination");
    await fs.writeFile(
        executable,
        `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SYMPOSIUM_CLAUDE_ARGS, JSON.stringify(args) + "\\n");
const resumeAt = args.indexOf("--resume");
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : "new-session";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", () => {
    setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\\n");
    }, 100);
});
`,
        { mode: 0o755 },
    );

    const config = {
        executable,
        model: "",
        permissionMode: "plan",
        env: { SYMPOSIUM_CLAUDE_ARGS: argsLog },
    };
    const options = { cwd: process.cwd(), resumeSessionId: "shared-resume-session" };
    const first = new ClaudeSession(
        config,
        options,
        new ClaudeSessionCoordination({ root: coordinationRoot }),
    );
    const second = new ClaudeSession(
        config,
        options,
        new ClaudeSessionCoordination({ root: coordinationRoot }),
    );

    try {
        const firstTurn = waitForTurnEnd(first);
        const blockedTurn = waitForTurnEnd(second);
        first.send("first window");
        second.send("overlap");

        const blockedEvents = await blockedTurn;
        assert.ok(
            blockedEvents.some(
                (event) =>
                    event.kind === "error" &&
                    /already running in another code-server window/.test(event.message),
            ),
        );
        await firstTurn;

        const secondTurn = waitForTurnEnd(second);
        second.send("second window after release");
        await secondTurn;

        const firstAgain = waitForTurnEnd(first);
        first.send("first window after external change");
        await firstAgain;

        const launches = (await fs.readFile(argsLog, "utf8")).trim().split("\n");
        assert.equal(launches.length, 3);
    } finally {
        first.dispose();
        second.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("Claude resumes a listed subagent through its parent conversation UUID", () => {
    assert.equal(
        claudeResumeSessionId(
            "33cce505-8848-4f48-88a5-da7faedcd4f2/subagents/agent-a1bb4e66e2be943da",
        ),
        "33cce505-8848-4f48-88a5-da7faedcd4f2",
    );
});

test("Claude keeps normal session ids and titles unchanged", () => {
    assert.equal(
        claudeResumeSessionId("33cce505-8848-4f48-88a5-da7faedcd4f2"),
        "33cce505-8848-4f48-88a5-da7faedcd4f2",
    );
    assert.equal(claudeResumeSessionId("my named session"), "my named session");
    assert.equal(
        claudeResumeSessionId("not-a-uuid/subagents/agent-123"),
        "not-a-uuid/subagents/agent-123",
    );
});

test("Claude treats the interrupted result from steer as a normal turn end", () => {
    const session = new ClaudeSession(
        { executable: "claude", model: "", permissionMode: "plan", env: {} },
        { cwd: process.cwd() },
    );
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));
    const sourceChild = {} as ChildProcessWithoutNullStreams;
    const internals = session as unknown as {
        handleLine(line: string, sourceChild?: ChildProcessWithoutNullStreams): void;
        cancelledChildren: WeakSet<ChildProcessWithoutNullStreams>;
    };
    const receive = internals.handleLine.bind(session);

    internals.cancelledChildren.add(sourceChild);
    receive(
        JSON.stringify({
            type: "result",
            is_error: true,
            result: "Request ended before the agent could reply.",
        }),
        sourceChild,
    );

    assert.equal(
        events.some((event) => event.kind === "error"),
        false,
    );
    assert.equal(events.at(-1)?.kind, "turn-end");
    session.dispose();
});

test("Claude emits native TaskCreate/TaskUpdate snapshots for the plan panel", () => {
    const session = new ClaudeSession(
        { executable: "claude", model: "", permissionMode: "plan", env: {} },
        { cwd: process.cwd() },
    );
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));
    const receive = (session as unknown as { handleLine(line: string): void }).handleLine.bind(
        session,
    );

    receive(
        JSON.stringify({
            type: "assistant",
            message: {
                content: [
                    {
                        type: "tool_use",
                        id: "create-1",
                        name: "TaskCreate",
                        input: { subject: "Inspect Claude task events" },
                    },
                ],
            },
        }),
    );
    receive(
        JSON.stringify({
            type: "user",
            toolUseResult: { task: { id: "4", subject: "Inspect Claude task events" } },
            message: {
                content: [
                    { type: "tool_result", tool_use_id: "create-1", content: "Task #4 created" },
                ],
            },
        }),
    );
    receive(
        JSON.stringify({
            type: "assistant",
            message: {
                content: [
                    {
                        type: "tool_use",
                        id: "update-1",
                        name: "TaskUpdate",
                        input: { taskId: "4", status: "in_progress" },
                    },
                ],
            },
        }),
    );

    const snapshots = events.filter(
        (event): event is Extract<AgentEvent, { kind: "tool-start" }> =>
            event.kind === "tool-start" && !!event.todos,
    );
    assert.deepEqual(
        snapshots.map((event) => event.todos),
        [
            [{ content: "Inspect Claude task events", status: "pending", order: 1 }],
            [{ content: "Inspect Claude task events", status: "in_progress", order: 1 }],
        ],
    );
    session.dispose();
});
