import assert from "node:assert/strict";
import test from "node:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { AhpProjectionRuntime, type AhpProjectionSessionInfo } from "../ahp";
import { selectPendingMessages } from "../ahp/client/chatSelectors";

/**
 * Reproduces the state the direct AHP presentation consumes, using the real
 * projection runtime rather than a parallel render-message translation.
 *
 * The reported defect is a UI contradiction: one message rendered as a
 * transcript bubble AND listed in the Queued panel at the same time. It is
 * always the FIRST send after an idle period (a direct dispatch); while a turn
 * is already running the queue behaves.
 *
 * This suite keeps the historical optimistic queued row as an adversarial
 * input for older/reconnecting clients. Current clients submit kind:"send"
 * and only the host projection creates queued rows, but every interleaving
 * below must remain safe during rollout and persisted-state recovery.
 */

const TEXT = "o symposium possui api";
const CLIENT_ID = "local-msnq-1";
const TURN_ID = "codex-session/turn-1";

const INFO: AhpProjectionSessionInfo = {
    backend: "codex",
    sessionId: "codex-session",
    title: "Contradiction",
    cwd: "/tmp",
};

/** Historical optimistic row from clients predating host-only queue truth. */
function optimisticRow(): Record<string, unknown> {
    return {
        type: "chat/pendingMessageSet",
        kind: "queued",
        id: CLIENT_ID,
        message: { text: TEXT, origin: { kind: "user" } },
    };
}

/** Render messages the controller emits for an IDLE direct dispatch, in order:
 *  the queue snapshot (empty — nothing was queued), the user row, then the
 *  backend's turn-start. */
const HOST_MESSAGES: unknown[] = [
    { type: "queue", items: [], held: false, busy: false },
    { type: "user", text: TEXT, attachments: [], clientMessageId: CLIENT_ID },
    { type: "event", event: { kind: "turn-start", logicalTurnId: TURN_ID } },
];

interface Harness {
    projection: AhpProjectionRuntime;
    chatResource: string;
    emit(message: unknown): void;
    dispatchOptimistic(): void;
    state(): ChatState;
}

function harness(): Harness {
    let observer: ((message: unknown) => void) | undefined;
    const projection = new AhpProjectionRuntime({
        list: () => [INFO],
        follow: (_id, next) => {
            observer = next;
            return () => undefined;
        },
    });
    projection.sync();
    const handle = projection.runtime.sessionByNative(INFO.backend, INFO.sessionId);
    assert.ok(handle, "the projection registered the session");
    return {
        projection,
        chatResource: handle.chatResource,
        emit: (message) => observer?.(message),
        dispatchOptimistic: () => projection.runtime.dispatch(handle.chatResource, optimisticRow()),
        state: () => projection.runtime.snapshot(handle.chatResource).state as ChatState,
    };
}

/** What the panel and the transcript would show, straight off the rebuild the
 *  webview consumes. */
function rendered(chat: ChatState): { bubbles: number; queued: string[] } {
    const turns = [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])];
    const bubbles = turns.filter((turn) => turn.message.text === TEXT).length;
    return {
        bubbles,
        queued: selectPendingMessages(chat).map((item) => item.text),
    };
}

/**
 * The optimistic row can land at any point relative to the host's own
 * messages. Every position must converge on the same UI.
 */
const POSITIONS = [0, 1, 2, 3] as const;

for (const position of POSITIONS) {
    test(`no UI contradiction when the optimistic row lands at position ${position}`, () => {
        const h = harness();
        for (let index = 0; index <= HOST_MESSAGES.length; index++) {
            if (index === position) h.dispatchOptimistic();
            if (index < HOST_MESSAGES.length) h.emit(HOST_MESSAGES[index]);
        }

        const view = rendered(h.state());
        assert.equal(view.bubbles, 1, "the message renders once in the transcript");
        assert.deepEqual(
            view.queued,
            [],
            "and is NOT also listed as pending — this is the reported defect",
        );
    });
}

/**
 * The turn finished and the host went idle, yet the row is still listed and is
 * never sent. That is the state the user photographed: an idle host whose queue
 * is empty, and a client row nothing drains. Modelled with the user row
 * carrying NO clientMessageId, which is what defeats every id-keyed guard.
 */
test("an idle host with an empty queue leaves no pending row behind", () => {
    const h = harness();
    h.emit({ type: "queue", items: [], held: false, busy: false });
    h.emit({ type: "user", text: TEXT, attachments: [] });
    h.emit({ type: "event", event: { kind: "turn-start", logicalTurnId: TURN_ID } });
    h.dispatchOptimistic();
    h.emit({ type: "event", event: { kind: "turn-end", durationMs: 9200 } });
    h.emit({ type: "queue", items: [], held: false, busy: false });

    assert.deepEqual(
        rendered(h.state()).queued,
        [],
        "the host reported an empty queue while idle — nothing may still be listed",
    );
});

/** A genuinely queued message (sent while a turn runs) must still show. */
test("a message the host really queued stays in the panel", () => {
    const h = harness();
    h.emit({ type: "event", event: { kind: "turn-start", logicalTurnId: "codex-session/turn-0" } });
    h.dispatchOptimistic();
    h.emit({
        type: "queue",
        items: [{ id: 1, clientMessageId: CLIENT_ID, text: TEXT, attachments: [] }],
        held: false,
        busy: true,
    });

    assert.deepEqual(rendered(h.state()).queued, [TEXT], "real pending work is still shown");
});

test("history reload after queued dispatch does not duplicate the active user bubble", () => {
    const h = harness();
    const ts = Date.parse("2026-08-27T12:44:07.391Z");
    h.emit({
        type: "queue",
        items: [
            {
                id: 1,
                clientMessageId: CLIENT_ID,
                text: TEXT,
                attachments: [],
                createdAt: ts,
            },
        ],
        held: false,
        busy: true,
    });
    h.emit({ type: "queue", items: [], held: false, busy: false });
    h.emit({
        type: "user",
        text: TEXT,
        attachments: [],
        clientMessageId: CLIENT_ID,
        ts,
    });
    h.emit({ type: "event", event: { kind: "turn-start", logicalTurnId: TURN_ID } });
    h.emit({
        type: "history",
        replace: true,
        messages: [{ role: "user", text: TEXT, ts }],
    });

    assert.equal(rendered(h.state()).bubbles, 1);
});

test("turn start removes the same history row when reload wins the race", () => {
    const h = harness();
    const ts = Date.parse("2026-08-27T12:44:07.391Z");
    h.emit({
        type: "user",
        text: TEXT,
        attachments: [],
        clientMessageId: CLIENT_ID,
        ts,
    });
    h.emit({
        type: "history",
        replace: true,
        messages: [{ role: "user", text: TEXT, ts }],
    });
    h.emit({ type: "event", event: { kind: "turn-start", logicalTurnId: TURN_ID } });

    assert.equal(rendered(h.state()).bubbles, 1);
});

test("identical messages sent at different times remain separate turns", () => {
    const h = harness();
    const currentTs = Date.parse("2026-08-27T12:44:07.391Z");
    h.emit({
        type: "user",
        text: TEXT,
        attachments: [],
        clientMessageId: CLIENT_ID,
        ts: currentTs,
    });
    h.emit({ type: "event", event: { kind: "turn-start", logicalTurnId: TURN_ID } });
    h.emit({
        type: "history",
        replace: true,
        messages: [
            {
                role: "user",
                text: TEXT,
                ts: Date.parse("2026-08-27T11:44:07.391Z"),
            },
        ],
    });

    assert.equal(rendered(h.state()).bubbles, 2);
});
