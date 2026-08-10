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
import { ahpChatToLegacy } from "../ahp/client/legacyView";

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

    assert.deepEqual(
        ahpChatToLegacy(state).filter(
            (m) => (m as { event?: { kind?: string } }).event?.kind === "status-notice",
        ),
        [
            {
                type: "event",
                event: {
                    kind: "status-notice",
                    text: "Stopped because the model repeated the same tool call.",
                    severity: "warning",
                    terminal: true,
                },
            },
        ],
        "and replays to the webview as the notice event it started as",
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
