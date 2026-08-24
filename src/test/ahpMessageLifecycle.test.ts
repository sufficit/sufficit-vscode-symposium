import assert from "node:assert/strict";
import test from "node:test";
import type { ActionEnvelope, ChatState } from "@microsoft/agent-host-protocol";
import type { PendingMessage as HostQueueItem } from "../application/controllerQueue";
import { chatReducer } from "../ahp/chatReducer";
import { selectPendingMessages } from "../ahp/client/chatSelectors";
import {
    createProjectionState,
    createQueueProjectionState,
    projectAgentEvent,
    projectQueue,
    rememberProjectedUser,
    type AhpProjectionAction,
} from "../ahp";

/**
 * Invariant suite for docs/plans/20260810-message-lifecycle-hardening.md.
 *
 * Composes the real pipeline pieces (projectAgentEvent / projectQueue →
 * chatReducer → direct ChatState selectors) end-to-end without DOM, to
 * catch the "message appears in transcript AND stays as a ghost queue row"
 * bug class. No production file is touched here — a failing assertion is a
 * finding, not something this suite patches over.
 */

const CHAT = "ahp-chat:/44444444-4444-4444-8444-444444444444";

function initialChat(): ChatState {
    return {
        resource: CHAT,
        title: "Lifecycle",
        status: 33,
        modifiedAt: "2026-08-10T00:00:00.000Z",
        turns: [],
    } as unknown as ChatState;
}

/** Client-side optimistic row, dispatched the instant the composer sends —
 *  mirrors AhpMessagePortTransport, ahead of any host response. */
function optimisticPending(
    kind: "queued" | "steering",
    id: string,
    text: string,
): Record<string, unknown> {
    return {
        type: "chat/pendingMessageSet",
        kind,
        id,
        message: { text, origin: { kind: "user" } },
    };
}

/** Host ChatQueue snapshot item, as projectQueue consumes it. */
function queueItem(id: string, text: string, mode: "queue" | "steer"): HostQueueItem {
    return { clientMessageId: id, text, attachments: [], mode };
}

/** Holds one client ChatState and replays AHP actions through chatReducer,
 *  each wrapped in an envelope the way SymposiumAhpState.apply does it. */
class Harness {
    chat: ChatState;
    private seq = 0;

    constructor(chat: ChatState = initialChat()) {
        this.chat = chat;
    }

    dispatch(action: Record<string, unknown>): ActionEnvelope {
        this.seq += 1;
        const envelope = {
            channel: CHAT,
            serverSeq: this.seq,
            origin: undefined,
            action,
        } as unknown as ActionEnvelope;
        this.chat = chatReducer(this.chat, envelope.action as never);
        return envelope;
    }

    /** Applies a projection batch (from projectAgentEvent/projectQueue),
     *  keeping only chat-channel actions — session actions are outside this
     *  suite's scope (transcript + queue only). */
    dispatchAll(actions: AhpProjectionAction[]): void {
        for (const item of actions) {
            if (item.channel === "chat") this.dispatch(item.action);
        }
    }
}

/** Runs one AgentEvent "turn-start" through a fresh projection, as the
 *  projection runtime does after rememberProjectedUser. `queuedMessageId`
 *  undefined models an id lost in transit. */
function dispatchTurnStart(
    harness: Harness,
    turnId: string,
    text: string,
    queuedMessageId: string | undefined,
): void {
    const projection = createProjectionState();
    rememberProjectedUser(projection, text, undefined, undefined, queuedMessageId);
    harness.dispatchAll(
        projectAgentEvent(projection, { kind: "turn-start", logicalTurnId: turnId }),
    );
}

type ConservationCase = readonly [kind: "queued" | "steering", hostQueued: boolean];

const CONSERVATION_CASES: ConservationCase[] = [
    ["queued", true],
    ["queued", false],
    ["steering", true],
    ["steering", false],
];

/** Full send flow for one message: optimistic pending row, optionally a
 *  host ChatQueue round trip (sat in the queue, then dequeued), then the
 *  backend's turn-start. */
function runConservationCase(
    kind: "queued" | "steering",
    hostQueued: boolean,
    id: string,
    text: string,
    turnId: string,
): Harness {
    const harness = new Harness();
    harness.dispatch(optimisticPending(kind, id, text));
    if (!hostQueued) {
        dispatchTurnStart(harness, turnId, text, id);
        return harness;
    }
    const queueState = createQueueProjectionState();
    const mode = kind === "steering" ? "steer" : "queue";
    harness.dispatchAll(projectQueue(queueState, [queueItem(id, text, mode)]));
    dispatchTurnStart(harness, turnId, text, id);
    harness.dispatchAll(projectQueue(queueState, [])); // host dequeues
    return harness;
}

test("CONSERVATION — optimistic pending clears exactly once across host paths", () => {
    CONSERVATION_CASES.forEach(([kind, hostQueued], index) => {
        const id = `case-${index + 1}`;
        const label = `${kind}/${hostQueued ? "queued-then-dispatched" : "direct"}`;
        const harness = runConservationCase(
            kind,
            hostQueued,
            id,
            `text ${index + 1}`,
            `turn-${index + 1}`,
        );
        assert.equal(
            harness.chat.queuedMessages?.some((item) => item.id === id) ?? false,
            false,
            `${label}: queuedMessages must not retain ${id}`,
        );
        assert.notEqual(
            harness.chat.steeringMessage?.id,
            id,
            `${label}: steeringMessage must not retain ${id}`,
        );
        const turns = [
            ...harness.chat.turns,
            ...(harness.chat.activeTurn ? [harness.chat.activeTurn] : []),
        ];
        assert.equal(
            turns.filter((turn) => turn.message.text === `text ${index + 1}`).length,
            1,
            `${label}: exactly one authoritative turn for ${id}`,
        );
    });
});

test("NO-DROP / SUPERSEDE — a stuck activeTurn never swallows the next turnStarted (queued)", () => {
    const harness = new Harness();
    // turn-1 starts and is never completed — a dropped turnComplete, codex's
    // "duplicate turn-end suppressed", or a transport reconnect that makes
    // the host projection lose track of it. activeTurn stays stuck.
    dispatchTurnStart(harness, "turn-1", "first message", undefined);
    assert.equal(harness.chat.activeTurn?.id, "turn-1");

    harness.dispatch(optimisticPending("queued", "msg-2", "second message"));
    dispatchTurnStart(harness, "turn-2", "second message", "msg-2");

    const chat = harness.chat;
    assert.equal(chat.activeTurn?.id, "turn-2", "turn-2 becomes the active turn");
    assert.equal(chat.turns.length, 1, "turn-1 is finalized, not dropped");
    assert.equal(chat.turns[0]?.id, "turn-1");
    assert.equal(chat.turns[0]?.state, "cancelled");
    assert.equal(
        chat.queuedMessages?.some((item) => item.id === "msg-2") ?? false,
        false,
        "msg-2's pending row is cleaned up despite the stuck turn",
    );
    assert.equal(
        chat.turns.length + (chat.activeTurn ? 1 : 0),
        2,
        "both messages remain in authoritative state — no drop",
    );
});

test("NO-DROP / SUPERSEDE — a stuck activeTurn never swallows the next turnStarted (steering)", () => {
    const harness = new Harness();
    dispatchTurnStart(harness, "turn-1", "first message", undefined);
    assert.equal(harness.chat.activeTurn?.id, "turn-1");

    harness.dispatch(optimisticPending("steering", "steer-2", "steer message"));
    assert.equal(harness.chat.steeringMessage?.id, "steer-2");
    dispatchTurnStart(harness, "turn-2", "steer message", "steer-2");

    const chat = harness.chat;
    assert.equal(chat.activeTurn?.id, "turn-2");
    assert.equal(chat.turns.length, 1);
    assert.equal(chat.turns[0]?.state, "cancelled");
    assert.equal(
        chat.steeringMessage,
        undefined,
        "steeringMessage is cleared despite the stuck turn",
    );
    assert.equal(chat.turns.length + (chat.activeTurn ? 1 : 0), 2);
});

test("STEER-VISIBILITY — steering row leads the queue rebuild until its turn starts", () => {
    const harness = new Harness();
    harness.dispatch(optimisticPending("queued", "q-1", "queued item"));
    harness.dispatch(optimisticPending("steering", "steer-1", "steer item"));

    const pending = selectPendingMessages(harness.chat);
    assert.equal(pending[0]?.id, "steer-1");
    assert.equal(pending[0]?.mode, "steer");

    dispatchTurnStart(harness, "turn-1", "steer item", "steer-1");

    assert.equal(
        selectPendingMessages(harness.chat).some(
            (item) => item.mode === "steer" || item.id === "steer-1",
        ),
        false,
        "the steering row is gone once its turn has started",
    );
});

test("GHOST-SWEEP — a pending row whose id was lost is pruned by the turn it belongs to", () => {
    const harness = new Harness();
    harness.dispatch(optimisticPending("queued", "ghost-1", "ghost text"));

    // The host's "user" event never carried clientMessageId (id lost in
    // transit — the shape of the first send after an idle period), so the
    // id-based cleanup cannot fire. The turn's own text identifies the row,
    // and startTurn drops it right there.
    const projection = createProjectionState();
    rememberProjectedUser(projection, "ghost text");
    harness.dispatchAll(
        projectAgentEvent(projection, { kind: "turn-start", logicalTurnId: "turn-1" }),
    );
    assert.equal(
        harness.chat.queuedMessages,
        undefined,
        "dropped at turn start, not left as a ghost",
    );

    harness.dispatchAll(projectAgentEvent(projection, { kind: "turn-end", durationMs: 5 }));

    assert.equal(harness.chat.queuedMessages, undefined, "and stays gone through turn end");
    assert.equal(
        selectPendingMessages(harness.chat).length,
        0,
        "no ghost queue row survives into a full rebuild",
    );
});

test("HOST-QUEUE ROUND TRIP — projectQueue add then remove converges to no pending rows", () => {
    const harness = new Harness();
    const queueState = createQueueProjectionState();

    const addActions = projectQueue(queueState, [
        queueItem("local-1", "steer via queue", "steer"),
    ]).filter((item) => item.channel === "chat");
    assert.deepEqual(
        addActions.map((item) => item.action.type),
        ["chat/pendingMessageSet"],
    );
    assert.equal(addActions[0]?.action.kind, "steering");
    harness.dispatchAll(addActions);
    assert.equal(harness.chat.steeringMessage?.id, "local-1");

    const removeActions = projectQueue(queueState, []).filter((item) => item.channel === "chat");
    assert.deepEqual(
        removeActions.map((item) => item.action.type),
        ["chat/pendingMessageRemoved"],
    );
    // Guards the kind-mismatch bug: the removal must repeat the SAME kind
    // ("steering") it was added with, or removePending silently no-ops.
    assert.equal(removeActions[0]?.action.kind, "steering");
    assert.equal(removeActions[0]?.action.id, "local-1");
    harness.dispatchAll(removeActions);

    assert.equal(harness.chat.steeringMessage, undefined);
    assert.equal(harness.chat.queuedMessages, undefined);
    assert.equal(selectPendingMessages(harness.chat).length, 0);
});
