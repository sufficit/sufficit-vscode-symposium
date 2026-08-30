import assert from "node:assert/strict";
import test from "node:test";
import type { ActionEnvelope, ChatState, Snapshot } from "@microsoft/agent-host-protocol";
import { SymposiumAhpState } from "../ahp/client/state";
import { pendingRemovalKind } from "../ahp/messagePortTransport";

/**
 * Regression suite for the rejected-envelope defects in
 * docs/plans/20260810-message-lifecycle-hardening.md (D1-D6): a client
 * action the host rejects must never mutate the direct ChatState mirror.
 */

const CHAT = "ahp-chat:/55555555-5555-4555-8555-555555555555";

function chatSnapshot(): Snapshot {
    return {
        resource: CHAT,
        fromSeq: 5,
        state: {
            resource: CHAT,
            title: "Rejection",
            status: 33,
            modifiedAt: "2026-08-10T00:00:00.000Z",
            turns: [],
        } as unknown as ChatState,
    } as Snapshot;
}

function envelope(serverSeq: number, action: unknown, rejectionReason?: string): ActionEnvelope {
    return {
        channel: CHAT,
        serverSeq,
        origin: undefined,
        action,
        ...(rejectionReason ? { rejectionReason } : {}),
    } as unknown as ActionEnvelope;
}

function chatWith(fields: Partial<ChatState>): ChatState {
    return {
        resource: CHAT,
        title: "Rejection",
        status: 33,
        modifiedAt: "2026-08-10T00:00:00.000Z",
        turns: [],
        ...fields,
    } as unknown as ChatState;
}

// --- (a) apply() on a rejected envelope ---

test("apply() advances lastServerSeq on a rejected envelope without reducing", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    const rejected = envelope(
        101,
        {
            type: "chat/pendingMessageSet",
            kind: "queued",
            id: "client-1",
            message: { text: "hello", origin: { kind: "user" } },
        },
        "session is not live",
    );
    assert.equal(state.apply(rejected), "rejected");
    assert.equal(state.lastServerSeq, 101, "the seq still advances on rejection");
    assert.equal(
        state.chats.get(CHAT)?.queuedMessages,
        undefined,
        "the reducer never ran — the rejected id must not appear in the queue",
    );
});

test("apply() reports ignored for a stale/duplicate serverSeq, distinct from rejected", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    const accepted = envelope(101, {
        type: "chat/pendingMessageSet",
        kind: "queued",
        id: "client-1",
        message: { text: "hello", origin: { kind: "user" } },
    });
    assert.equal(state.apply(accepted), "reduced");
    assert.equal(state.apply(accepted), "ignored");
});

test("rejected explicit submission advances sequence without changing chat state", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    const rejected = envelope(
        101,
        {
            type: "symposium/messageSubmitted",
            id: "submission-1",
            mode: "send",
            message: { text: "ghost", origin: { kind: "user" } },
        },
        "message could not be sent",
    );
    assert.equal(state.apply(rejected), "rejected");
    assert.equal(state.lastServerSeq, 101);
    assert.equal(state.chats.get(CHAT)?.activeTurn, undefined);
    assert.equal(state.chats.get(CHAT)?.queuedMessages, undefined);
});

// --- (d) transport removal kind ---

test("pendingRemovalKind matches steering by id, else falls back to queued", () => {
    const chat = chatWith({
        steeringMessage: {
            id: "steer-1",
            message: { text: "fix", origin: { kind: "user" } },
        } as unknown as ChatState["steeringMessage"],
    });
    assert.equal(pendingRemovalKind(chat, "steer-1"), "steering");
    assert.equal(pendingRemovalKind(chat, "queued-1"), "queued");

    const noSteering = chatWith({});
    assert.equal(pendingRemovalKind(noSteering, "steer-1"), "queued");
});
