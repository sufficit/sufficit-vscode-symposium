import assert from "node:assert/strict";
import test from "node:test";
import type { ActionEnvelope, ChatState, Snapshot } from "@microsoft/agent-host-protocol";
import { SymposiumAhpState } from "../ahp/client/state";
import {
    ahpActionToLegacy,
    ahpChatToLegacy,
    rejectedEnvelopeFallback,
} from "../ahp/client/legacyView";
import { pendingRemovalKind } from "../ahp/messagePortTransport";

/**
 * Regression suite for the rejected-envelope defects in
 * docs/plans/20260810-message-lifecycle-hardening.md (D1-D6): a client
 * action the host rejects must never be translated as if it had been
 * accepted, and the pieces that clean up after a rejection must be pure
 * functions testable without DOM.
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

// --- (b) legacyView queue messages carry busy ---

test("ahpChatToLegacy's queue rebuild carries busy from chat.activeTurn", () => {
    const idleChat = chatWith({
        queuedMessages: [
            { id: "q1", message: { text: "queued", origin: { kind: "user" } } },
        ] as unknown as ChatState["queuedMessages"],
    });
    const idleQueue = ahpChatToLegacy(idleChat).find((m) => m.type === "queue") as
        | { busy?: boolean }
        | undefined;
    assert.equal(idleQueue?.busy, false);

    const busyChat = chatWith({
        queuedMessages: idleChat.queuedMessages,
        activeTurn: {
            id: "t1",
            startedAt: "2026-08-10T00:00:00.000Z",
            message: { text: "hi", origin: { kind: "user" } },
            responseParts: [],
        } as unknown as ChatState["activeTurn"],
    });
    const busyQueue = ahpChatToLegacy(busyChat).find((m) => m.type === "queue") as
        | { busy?: boolean }
        | undefined;
    assert.equal(busyQueue?.busy, true);
});

test("ahpActionToLegacy's pendingMessageRemoved rebuild carries busy from chat.activeTurn", () => {
    const busyChat = chatWith({
        queuedMessages: [
            { id: "q1", message: { text: "queued", origin: { kind: "user" } } },
        ] as unknown as ChatState["queuedMessages"],
        activeTurn: {
            id: "t1",
            startedAt: "2026-08-10T00:00:00.000Z",
            message: { text: "hi", origin: { kind: "user" } },
            responseParts: [],
        } as unknown as ChatState["activeTurn"],
    });
    const removed = envelope(6, { type: "chat/pendingMessageRemoved", id: "q1", kind: "queued" });
    const queue = ahpActionToLegacy(removed, busyChat).find((m) => m.type === "queue") as
        | { busy?: boolean }
        | undefined;
    assert.equal(queue?.busy, true);
});

// --- (c) rejected pendingMessageSet -> queue rebuild + toast ---

test("rejectedEnvelopeFallback rebuilds the queue and toasts for a rejected pendingMessageSet", () => {
    const chat = chatWith({
        queuedMessages: [
            { id: "other", message: { text: "still queued", origin: { kind: "user" } } },
        ] as unknown as ChatState["queuedMessages"],
    });
    const rejected = envelope(
        7,
        {
            type: "chat/pendingMessageSet",
            kind: "queued",
            id: "ghost-1",
            message: { text: "ghost", origin: { kind: "user" } },
        },
        "session is not live",
    );
    const fallback = rejectedEnvelopeFallback(rejected, chat);
    const queue = fallback.find((m) => m.type === "queue") as
        | { items: { id: string }[]; busy?: boolean; stale?: string[] }
        | undefined;
    const toast = fallback.find((m) => m.type === "toast") as { text: string } | undefined;

    assert.ok(queue, "a queue rebuild is emitted");
    assert.ok(toast, "a toast is emitted");
    assert.equal(
        queue?.items.some((item) => item.id === "ghost-1"),
        false,
        "the rejected id never entered the real queue",
    );
    assert.equal(
        queue?.items.some((item) => item.id === "other"),
        true,
        "other real queue items survive the rebuild",
    );
    assert.deepEqual(
        queue?.stale,
        ["ghost-1"],
        "the rejected id is listed so the client withdraws its ghost bubble",
    );
    assert.match(toast!.text, /rejected/i);
    assert.match(toast!.text, /session is not live/);
});

test("rejected explicit submission withdraws its optimistic bubble without changing queue", () => {
    const chat = chatWith({});
    const rejected = envelope(
        8,
        {
            type: "symposium/messageSubmitted",
            id: "submission-1",
            mode: "send",
            message: { text: "ghost", origin: { kind: "user" } },
        },
        "message could not be sent",
    );

    assert.deepEqual(rejectedEnvelopeFallback(rejected, chat), [
        {
            type: "queue",
            items: [],
            busy: false,
            held: false,
            stale: ["submission-1"],
        },
        { type: "toast", text: "Message rejected: message could not be sent" },
    ]);
});

test("rejectedEnvelopeFallback is silent for action types with no optimistic UI to undo", () => {
    const chat = chatWith({
        activeTurn: {
            id: "t1",
            startedAt: "2026-08-10T00:00:00.000Z",
            message: { text: "hi", origin: { kind: "user" } },
            responseParts: [],
        } as unknown as ChatState["activeTurn"],
    });
    const cancelRejected = envelope(
        9,
        { type: "chat/turnCancelled", turnId: "t1", duration: 0 },
        "session is not live",
    );
    assert.deepEqual(rejectedEnvelopeFallback(cancelRejected, chat), []);

    const approvalRejected = envelope(
        10,
        { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tool-1", approved: true },
        "approval is not pending",
    );
    assert.deepEqual(rejectedEnvelopeFallback(approvalRejected, chat), []);
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
