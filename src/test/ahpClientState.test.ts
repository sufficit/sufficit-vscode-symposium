import assert from "node:assert/strict";
import test from "node:test";
import type {
    ActionEnvelope,
    ChatState,
    SessionState,
    Snapshot,
} from "@microsoft/agent-host-protocol";
import { SymposiumAhpState } from "../ahp/client/state";
import { ahpActionToLegacy, ahpChatToLegacy } from "../ahp/client/legacyView";

const CHAT = "ahp-chat:/22222222-2222-4222-8222-222222222222";

function chatSnapshot(): Snapshot {
    return {
        resource: CHAT,
        fromSeq: 5,
        state: {
            resource: CHAT,
            title: "Client",
            status: 33,
            modifiedAt: "2026-08-09T00:00:00.000Z",
            turns: [],
        } as unknown as ChatState,
    } as Snapshot;
}

test("browser AHP mirror applies chat actions once across duplicate delivery", () => {
    const first = new SymposiumAhpState();
    const second = new SymposiumAhpState();
    first.applySnapshot(chatSnapshot());
    second.applySnapshot(chatSnapshot());
    const envelope = {
        channel: CHAT,
        serverSeq: 6,
        origin: undefined,
        action: {
            type: "chat/pendingMessageSet",
            kind: "queued",
            id: "client-1",
            message: { text: "queued", origin: { kind: "user" } },
        },
    } as unknown as ActionEnvelope;

    assert.equal(first.apply(envelope), true);
    assert.equal(first.apply(envelope), false);
    assert.equal(second.apply(envelope), true);
    assert.deepEqual(first.chats.get(CHAT), second.chats.get(CHAT));
    assert.equal(first.chats.get(CHAT)?.queuedMessages?.length, 1);
});

test("AHP legacy selector reconstructs transcript and incremental queue state", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    const started = {
        channel: CHAT,
        serverSeq: 6,
        origin: undefined,
        action: {
            type: "chat/turnStarted",
            turnId: "turn-1",
            startedAt: "2026-08-09T00:00:01.000Z",
            message: { text: "hello", origin: { kind: "user" } },
        },
    } as unknown as ActionEnvelope;
    state.apply(started);
    const messages = ahpActionToLegacy(started, state.chats.get(CHAT));
    assert.deepEqual(
        messages.map((message) => message.type),
        ["user", "event"],
    );
    assert.deepEqual(
        ahpChatToLegacy(state.chats.get(CHAT) as ChatState).map((message) => message.type),
        ["clear", "user", "event"],
    );
});

test("AHP client mirror replaces stale state on snapshot fallback", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot(chatSnapshot());
    const replacement = chatSnapshot();
    replacement.fromSeq = 100;
    replacement.state = {
        ...(replacement.state as ChatState),
        title: "Caught up",
    } as ChatState;
    state.applySnapshot(replacement);
    assert.equal(state.lastServerSeq, 100);
    assert.equal(state.chats.get(CHAT)?.title, "Caught up");
});

test("session snapshots remain independent from chat snapshots", () => {
    const state = new SymposiumAhpState();
    state.applySnapshot({
        resource: "ahp-session:/11111111-1111-4111-8111-111111111111",
        fromSeq: 1,
        state: {
            provider: "claude",
            title: "Session",
            status: 33,
            lifecycle: "ready",
            activeClients: [],
            chats: [],
        } as unknown as SessionState,
    });
    state.applySnapshot(chatSnapshot());
    assert.equal(state.sessions.size, 1);
    assert.equal(state.chats.size, 1);
});
