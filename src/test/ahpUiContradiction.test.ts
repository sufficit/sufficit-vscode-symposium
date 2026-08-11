import assert from "node:assert/strict";
import test from "node:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { AhpShadowRuntime, type AhpShadowSessionInfo } from "../ahp";
import { ahpChatToLegacy } from "../ahp/client/legacyView";
import type { HostToWebview } from "../protocol/chat";

/**
 * Reproduces what the user actually sees, using the REAL shadow runtime and
 * the real legacy translation — the layer every previous suite skipped.
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

const INFO: AhpShadowSessionInfo = {
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
    shadow: AhpShadowRuntime;
    chatResource: string;
    emit(message: unknown): void;
    dispatchOptimistic(): void;
    legacy(): HostToWebview[];
}

function harness(): Harness {
    let observer: ((message: unknown) => void) | undefined;
    const shadow = new AhpShadowRuntime({
        list: () => [INFO],
        follow: (_id, next) => {
            observer = next;
            return () => undefined;
        },
    });
    shadow.sync();
    const handle = shadow.runtime.sessionByNative(INFO.backend, INFO.sessionId);
    assert.ok(handle, "the shadow registered the session");
    return {
        shadow,
        chatResource: handle.chatResource,
        emit: (message) => observer?.(message),
        dispatchOptimistic: () => shadow.runtime.dispatch(handle.chatResource, optimisticRow()),
        legacy: () =>
            ahpChatToLegacy(shadow.runtime.snapshot(handle.chatResource).state as ChatState),
    };
}

/** What the panel and the transcript would show, straight off the rebuild the
 *  webview consumes. */
function rendered(messages: HostToWebview[]): { bubbles: number; queued: string[] } {
    const bubbles = messages.filter(
        (message) => message.type === "user" && (message as { text?: string }).text === TEXT,
    ).length;
    const last = [...messages].reverse().find((message) => message.type === "queue") as
        | { items?: { text?: string }[] }
        | undefined;
    return {
        bubbles,
        queued: (last?.items ?? []).map((item) => String(item.text)),
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

        const view = rendered(h.legacy());
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
        rendered(h.legacy()).queued,
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

    assert.deepEqual(rendered(h.legacy()).queued, [TEXT], "real pending work is still shown");
});
