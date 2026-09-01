import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../adapters/types";
import type { ChatState } from "@microsoft/agent-host-protocol";
import {
    createProjectionState,
    createQueueProjectionState,
    projectAgentEvent,
    projectInjectedUser,
    projectQueue,
    rememberProjectedUser,
    seedQueueProjection,
} from "../ahp";

/**
 * Recovery-path invariants for docs/plans/20260810-message-lifecycle-hardening.md
 * (E1/E2/E3): a mid-turn steer must land in the live turn's response stream,
 * a stale pendingUser slot must never leak into an unrelated later turn, and
 * a restored/preserved queue projection must be able to clean up rows it
 * never itself created via a `chat/pendingMessageSet`.
 */

const CHAT = "ahp-chat:/55555555-5555-5555-8555-555555555555";

function turnStart(id: string): AgentEvent {
    return { kind: "turn-start", logicalTurnId: id };
}

function turnEnd(durationMs = 5): AgentEvent {
    return { kind: "turn-end", durationMs };
}

function record(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

test("projectInjectedUser echoes into a live turn but no-ops without one", () => {
    const state = createProjectionState();
    assert.deepEqual(projectInjectedUser(state, "no turn yet", "client-0"), []);

    projectAgentEvent(state, turnStart("turn-1"));
    const actions = projectInjectedUser(state, "mid-turn steer", "client-1");

    assert.equal(actions.length, 1);
    assert.equal(actions[0].channel, "chat");
    const action = record(actions[0].action);
    assert.equal(action.type, "chat/responsePart");
    assert.equal(action.turnId, "turn-1");
    const part = record(action.part);
    assert.equal(part.kind, "user-echo");
    assert.equal(part.content, "mid-turn steer");
    assert.deepEqual(part._meta, { clientMessageId: "client-1" });
});

test("resetTurn clears pendingUser so a later turn-start with no user emit is synthetic", () => {
    const state = createProjectionState();
    rememberProjectedUser(state, "first turn text", undefined, undefined, "client-1");
    projectAgentEvent(state, turnStart("turn-1"));
    projectAgentEvent(state, turnEnd());

    // retry-with-interruptedBy / continue-after-tool-cap: no user emit precedes this.
    const actions = projectAgentEvent(state, turnStart("turn-2"));
    const started = actions.find((item) => record(item.action).type === "chat/turnStarted");
    assert.ok(started);
    const action = record(started.action);
    assert.equal(action.queuedMessageId, undefined);
    const message = record(action.message);
    assert.equal(message.text, "");
    assert.deepEqual(message._meta, { synthetic: true });
});

test("automatic recovery projects as transient UI state outside conversation history", () => {
    const state = createProjectionState();
    projectAgentEvent(state, turnStart("failed-turn"));
    projectAgentEvent(state, turnEnd());

    const actions = projectAgentEvent(state, {
        kind: "status-notice",
        text: "Retrying automatically",
        severity: "warning",
        recovery: {
            id: "intent-1",
            state: "scheduled",
            attempt: 1,
            limit: 3,
            retryAt: 1_000,
            reason: "fetch failed",
        },
    });

    assert.equal(actions.length, 1);
    const action = record(actions[0].action);
    assert.equal(action.type, "symposium/recoveryStatus");
    assert.equal(action.content, "Retrying automatically");
    assert.deepEqual(action.recovery, {
        id: "intent-1",
        state: "scheduled",
        attempt: 1,
        limit: 3,
        retryAt: 1_000,
        reason: "fetch failed",
    });
});

test("seedQueueProjection lets an empty host queue remove restored queued and steering rows", () => {
    const chat = {
        resource: CHAT,
        title: "Recovery",
        status: 33,
        modifiedAt: "2026-08-10T00:00:00.000Z",
        turns: [],
        queuedMessages: [{ id: "queued-1", message: { text: "queued", origin: { kind: "user" } } }],
        steeringMessage: { id: "steer-1", message: { text: "steer", origin: { kind: "user" } } },
    } as unknown as ChatState;

    const queue = createQueueProjectionState();
    seedQueueProjection(queue, chat);

    // The host's own queue snapshot is empty (nothing survived the restart on
    // its side) — both restored rows must still be removable even though this
    // projection never saw a chat/pendingMessageSet for either id.
    const removed = projectQueue(queue, [])
        .filter((item) => record(item.action).type === "chat/pendingMessageRemoved")
        .map((item) => ({ id: record(item.action).id, kind: record(item.action).kind }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    assert.deepEqual(removed, [
        { id: "queued-1", kind: "queued" },
        { id: "steer-1", kind: "steering" },
    ]);
});
