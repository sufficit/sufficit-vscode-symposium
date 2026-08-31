import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../adapters/types";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import {
    AhpHostRuntime,
    createProjectionState,
    projectAgentEvent,
    rememberProjectedUser,
    sessionChatSummaryChanges,
    stableAhpUuid,
    type AhpProjectionAction,
} from "../ahp";
import { toolTodosFromMetadata } from "../ahp/toolMetadata";
import { historyTurns } from "../ahp/historyProjection";
import { readAssistantMetadata } from "../ahp/assistantMetadata";

const STREAM: AgentEvent[] = [
    { kind: "turn-start", logicalTurnId: "turn-1" },
    { kind: "thinking", text: "considering" },
    { kind: "text", text: "hello" },
    { kind: "tool-start", toolName: "read_file", toolId: "tool-1", detail: "README" },
    { kind: "tool-output", toolId: "tool-1", text: "contents" },
    { kind: "tool-end", toolName: "read_file", toolId: "tool-1", result: "ok" },
    { kind: "usage", inputTokens: 10, outputTokens: 4, model: "model" },
    { kind: "turn-end", durationMs: 25 },
];

test("equivalent adapter streams project to the same backend-neutral transcript", () => {
    const states = ["claude", "codex", "copilot", "openai"].map((provider) =>
        runStream(provider, STREAM),
    );
    const normalized = states.map((state) => ({
        turns: state.turns.map(({ startedAt: _startedAt, ...turn }) => turn),
        activeTurn: state.activeTurn,
        status: state.status,
    }));
    assert.deepEqual(normalized.slice(1), [normalized[0], normalized[0], normalized[0]]);
    assert.equal(states[0].turns[0].state, "complete");
    assert.equal(states[0].turns[0].responseParts.length, 3);
});

test("failed and cancelled projections finish in distinct terminal states", () => {
    const failed = runStream("openai", [
        { kind: "turn-start", logicalTurnId: "failed" },
        { kind: "error", message: "denied", retryable: false },
        { kind: "turn-end" },
    ]);
    assert.equal(failed.turns[0].state, "error");
    assert.equal(failed.turns[0].error?.message, "denied");

    const runtime = fixture("claude");
    rememberProjectedUser(runtime.projection, "cancel me");
    apply(
        runtime,
        projectAgentEvent(runtime.projection, { kind: "turn-start", logicalTurnId: "c" }),
    );
    apply(runtime, [
        {
            channel: "chat",
            action: { type: "chat/turnCancelled", turnId: "c", duration: 1 },
        },
    ]);
    const chat = runtime.host.snapshot(runtime.handle.chatResource).state as ChatState;
    assert.equal(chat.turns[0].state, "cancelled");
});

test("history projection preserves terminal errors and retryability", () => {
    const [turn] = historyTurns([
        { role: "user", text: "Run the task" },
        { role: "assistant", text: "Partial reply" },
        { role: "error", text: "fetch failed", retryable: true },
    ]);

    assert.equal(turn.state, "error");
    assert.deepEqual(turn.error, {
        errorType: "agent",
        message: "fetch failed",
        _meta: { retryable: true },
    });
});

test("projection keeps tool approval correlation and excludes arbitrary provider metadata", () => {
    const runtime = fixture("openai");
    rememberProjectedUser(runtime.projection, "write");
    for (const event of [
        { kind: "turn-start", logicalTurnId: "approval" },
        { kind: "tool-start", toolName: "write_file", toolId: "write-1", path: "/tmp/a" },
        {
            kind: "approval-request",
            toolName: "write_file",
            toolId: "write-1",
            tier: "write",
            detail: "write a",
        },
        { kind: "approval-resolved", toolId: "write-1", approved: true },
    ] as AgentEvent[]) {
        apply(runtime, projectAgentEvent(runtime.projection, event));
    }
    const session = runtime.host.snapshot(runtime.handle.sessionResource).state as SessionState;
    const serialized = JSON.stringify(runtime.host.exportState());
    assert.equal(session.inputNeeded?.length ?? 0, 0);
    assert.equal(serialized.includes("process.env"), false);
    assert.equal(serialized.includes("credential"), false);
});

test("native task snapshots survive AHP projection, completion and replay state", () => {
    const runtime = fixture("claude");
    rememberProjectedUser(runtime.projection, "work");
    apply(
        runtime,
        projectAgentEvent(runtime.projection, {
            kind: "turn-start",
            logicalTurnId: "tasks",
        }),
    );
    apply(
        runtime,
        projectAgentEvent(runtime.projection, {
            kind: "tool-start",
            toolName: "TaskCreate",
            toolId: "create-1",
            path: "/tmp/work",
            todos: [{ content: "Inspect projection", status: "pending", order: 1 }],
        }),
    );

    const projectedTool = () => {
        const chat = runtime.host.snapshot(runtime.handle.chatResource).state as ChatState;
        const part = chat.activeTurn?.responseParts[0] as unknown as {
            toolCall?: { _meta?: unknown };
        };
        return part.toolCall?._meta;
    };
    assert.deepEqual(toolTodosFromMetadata(projectedTool()), [
        { content: "Inspect projection", status: "pending", order: 1 },
    ]);

    apply(
        runtime,
        projectAgentEvent(runtime.projection, {
            kind: "tool-end",
            toolName: "TaskCreate",
            toolId: "create-1",
            todos: [{ content: "Inspect projection", status: "in_progress", order: 1 }],
        }),
    );
    assert.deepEqual(toolTodosFromMetadata(projectedTool()), [
        { content: "Inspect projection", status: "in_progress", order: 1 },
    ]);
    assert.equal(
        (projectedTool() as { symposium?: { path?: string } }).symposium?.path,
        "/tmp/work",
        "completion metadata must not erase start metadata",
    );
});

test("native task snapshots survive backend history projection on session reopen", () => {
    const [turn] = historyTurns([
        { role: "user", text: "work" },
        {
            role: "tool",
            text: null,
            toolName: "TaskCreate",
            todos: [{ content: "Persist task panel", status: "pending", order: 1 }],
        },
    ]);
    const part = turn.responseParts[0] as unknown as { toolCall?: { _meta?: unknown } };
    assert.deepEqual(toolTodosFromMetadata(part.toolCall?._meta), [
        { content: "Persist task panel", status: "pending", order: 1 },
    ]);
});

test("assistant timestamp, model and effort survive live and history AHP projection", () => {
    const timestamp = Date.parse("2026-08-19T22:52:53.087Z");
    const state = runStream("claude", [
        { kind: "turn-start", logicalTurnId: "metadata" },
        {
            kind: "text",
            text: "answer",
            ts: timestamp,
            model: "claude-sonnet-5",
            reasoning: "xhigh",
        },
        { kind: "turn-end" },
    ]);
    const livePart = state.turns[0].responseParts[0] as unknown as {
        _meta?: { symposium?: Record<string, unknown> };
    };
    assert.deepEqual(livePart._meta?.symposium, {
        ts: timestamp,
        model: "claude-sonnet-5",
        reasoning: "xhigh",
    });

    const [history] = historyTurns([
        { role: "user", text: "question" },
        {
            role: "assistant",
            text: "answer",
            ts: timestamp,
            model: "claude-sonnet-5",
            reasoning: "xhigh",
        },
    ]);
    const historyPart = history.responseParts[0] as unknown as {
        _meta?: { symposium?: Record<string, unknown> };
    };
    assert.deepEqual(historyPart._meta?.symposium, livePart._meta?.symposium);
    assert.equal(
        history.startedAt,
        new Date(timestamp).toISOString(),
        "legacy user rows inherit the first real timestamp in their turn",
    );

    const submittedAt = Date.parse("2026-08-19T22:52:50.000Z");
    const [timestampedHistory] = historyTurns([
        { role: "user", text: "question", ts: submittedAt },
        { role: "assistant", text: "answer", ts: timestamp },
    ]);
    assert.equal(timestampedHistory.startedAt, new Date(submittedAt).toISOString());

    assert.deepEqual(
        readAssistantMetadata({
            symposium: {
                ts: "2026-08-19T22:52:53.087Z",
                model: "claude-sonnet-5",
                reasoning: "xhigh",
            },
        }),
        {
            ts: timestamp,
            model: "claude-sonnet-5",
            reasoning: "xhigh",
        },
        "AHP clients may serialize dates; the webview boundary normalizes them to milliseconds",
    );
});

// A terminal notice is why the turn stopped. Projected as activity only it was
// overwritten by the next event, so the transcript never explained the stop
// while the session badge still reported one.
test("a terminal status notice survives as a transcript part, not just activity", () => {
    const state = runStream("openai", [
        { kind: "turn-start", logicalTurnId: "turn-1" },
        { kind: "text", text: "working" },
        {
            kind: "status-notice",
            text: "Stopped because the model repeated the same tool call.",
            severity: "warning",
            terminal: true,
        },
        { kind: "turn-end", durationMs: 5 },
    ]);

    const parts = state.turns.flatMap((turn) => turn.responseParts) as unknown as Record<
        string,
        unknown
    >[];
    const notice = parts.find((part) => part.kind === "notice");
    assert.ok(notice, "the terminal notice is a durable response part");
    assert.equal(notice.content, "Stopped because the model repeated the same tool call.");
    assert.deepEqual(notice._meta, { severity: "warning" });

    assert.equal(
        parts.filter((part) => part.kind === "notice").length,
        1,
        "direct AHP clients receive one durable notice part",
    );
});

test("a non-terminal notice stays transient activity", () => {
    const state = runStream("openai", [
        { kind: "turn-start", logicalTurnId: "turn-1" },
        { kind: "status-notice", text: "compacting before the next request." },
        { kind: "turn-end", durationMs: 5 },
    ]);

    const parts = state.turns.flatMap((turn) => turn.responseParts) as unknown as Record<
        string,
        unknown
    >[];
    assert.equal(
        parts.some((part) => part.kind === "notice"),
        false,
    );
});

// FIX (2026-08-10): projectToolStart used to leave textPartId/reasoningPartId
// open across a tool call. chat/delta appends to whichever part is still
// open, so a whole turn's text funnelled into the ONE part created before the
// first tool — replay showed all text first and every tool bunched after it.
const INTERLEAVED_STREAM: AgentEvent[] = [
    { kind: "turn-start", logicalTurnId: "turn-1" },
    { kind: "text", text: "A" },
    { kind: "tool-start", toolName: "read_file", toolId: "t1", detail: "first" },
    { kind: "tool-end", toolName: "read_file", toolId: "t1", result: "ok" },
    { kind: "text", text: "B" },
    { kind: "tool-start", toolName: "read_file", toolId: "t2", detail: "second" },
    { kind: "tool-end", toolName: "read_file", toolId: "t2", result: "ok" },
    { kind: "text", text: "C" },
    { kind: "turn-end", durationMs: 5 },
];

test("response parts keep their chronological order across tool boundaries", () => {
    const state = runStream("openai", INTERLEAVED_STREAM);
    const parts = state.turns[0].responseParts as unknown as {
        kind: string;
        content?: string;
    }[];
    assert.deepEqual(
        parts.map((part) => part.kind),
        ["markdown", "toolCall", "markdown", "toolCall", "markdown"],
        "text must not funnel into one part while tools bunch at the end",
    );
    assert.deepEqual(
        parts.filter((part) => part.kind === "markdown").map((part) => part.content),
        ["A", "B", "C"],
        "each text run is its own part, not one concatenated blob",
    );
});

test("reasoning parts also stay separate across a tool boundary", () => {
    const runtime = fixture("openai");
    rememberProjectedUser(runtime.projection, "question");
    for (const event of [
        { kind: "turn-start", logicalTurnId: "turn-1" },
        { kind: "thinking", text: "r1" },
        { kind: "tool-start", toolName: "read_file", toolId: "t1", detail: "look" },
        { kind: "thinking", text: "r2" },
    ] as AgentEvent[]) {
        apply(runtime, projectAgentEvent(runtime.projection, event));
    }
    const chat = runtime.host.snapshot(runtime.handle.chatResource).state as ChatState;
    const active = chat.activeTurn;
    assert.ok(active, "the turn is still open (no turn-end sent yet)");
    const reasoning = (
        active!.responseParts as unknown as { kind: string; content?: string }[]
    ).filter((part) => part.kind === "reasoning");
    assert.deepEqual(
        reasoning.map((part) => part.content),
        ["r1", "r2"],
        "two separate reasoning parts, not one part holding both",
    );
});

test("authoritative response parts retain tool ids and chronological order", () => {
    const state = runStream("openai", INTERLEAVED_STREAM);
    const parts = state.turns[0].responseParts as unknown as Array<{
        kind: string;
        toolCall?: { toolCallId?: string };
    }>;
    const toolIds = parts.flatMap((part) =>
        part.kind === "toolCall" && part.toolCall?.toolCallId ? [part.toolCall.toolCallId] : [],
    );
    assert.deepEqual(toolIds, ["t1", "t2"], "tool order is preserved, not collapsed together");
});

function runStream(provider: string, events: AgentEvent[]): ChatState {
    const runtime = fixture(provider);
    rememberProjectedUser(runtime.projection, "question", "model");
    for (const event of events) apply(runtime, projectAgentEvent(runtime.projection, event));
    return runtime.host.snapshot(runtime.handle.chatResource).state as ChatState;
}

function fixture(provider: string) {
    const host = new AhpHostRuntime();
    const handle = host.registerSession({
        provider,
        nativeSessionId: `${provider}-native`,
        title: "Projection",
        stableId: stableAhpUuid(`session:${provider}`),
        chatId: stableAhpUuid(`chat:${provider}`),
    });
    return { host, handle, projection: createProjectionState() };
}

function apply(runtime: ReturnType<typeof fixture>, actions: AhpProjectionAction[]): void {
    for (const projected of actions) {
        const resource =
            projected.channel === "chat"
                ? runtime.handle.chatResource
                : runtime.handle.sessionResource;
        const action = { ...projected.action };
        if (action.type === "session/inputNeededSet") {
            const request = action.request as Record<string, unknown>;
            action.request = { ...request, chat: runtime.handle.chatResource };
        }
        runtime.host.dispatch(resource, action);
        if (projected.channel === "chat") {
            const chat = runtime.host.snapshot(runtime.handle.chatResource).state as ChatState;
            runtime.host.dispatch(runtime.handle.sessionResource, {
                type: "session/chatUpdated",
                chat: runtime.handle.chatResource,
                changes: sessionChatSummaryChanges(chat),
            });
        }
    }
}
