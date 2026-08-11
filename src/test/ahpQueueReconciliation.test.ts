import assert from "node:assert/strict";
import test from "node:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { ChatController } from "../application/chatController";
import type { AgentAdapter, SessionStartOptions } from "../adapters/types";
import type { ApplicationPorts } from "../application/ports";
import { seedQueueProjection, createQueueProjectionState, projectQueue } from "../ahp";
import { chatReducer } from "../ahp/chatReducer";

/**
 * Regression suite for FIX A (docs/plans/20260810-message-lifecycle-hardening.md):
 * the AHP shadow attaches via subscribeLive and may be restoring a ChatState
 * persisted across a restart whose queuedMessages/steeringMessage rows the
 * host queue no longer has. Live observers previously got no replay, so
 * nothing ever contradicted those rows and they stayed in the Queued panel
 * forever (CONFIRMED in production).
 */

function stubAdapter(): AgentAdapter {
    return {
        backend: "test",
        usage: {
            backend: "test",
            displayName: "Test",
            read: () => Promise.reject(new Error("not used in this test")),
        },
        available: () => Promise.resolve({ ok: true }),
        listSessions: () => Promise.resolve([]),
        start: () => {
            throw new Error("not used in this test");
        },
    } as unknown as AgentAdapter;
}

function stubPorts(): ApplicationPorts {
    // The constructor only stores this bag and passes it down to the turn
    // runner; nothing in subscribeLive() touches it.
    return {} as unknown as ApplicationPorts;
}

test("subscribeLive immediately delivers a queue snapshot", () => {
    const options: SessionStartOptions = { cwd: process.cwd() };
    const controller = new ChatController(stubAdapter(), options, stubPorts());
    const received: unknown[] = [];
    const detach = controller.subscribeLive((message) => received.push(message));

    assert.equal(received.length, 1, "the live observer gets exactly one immediate message");
    assert.deepEqual(received[0], { type: "queue", items: [], held: false, busy: false });

    detach();
});

test("a restored ghost queue row is removed once the host queue snapshot arrives", () => {
    // Simulates a state.json persisted across a restart: the client ChatState
    // still carries a queued row, but this session's host ChatQueue is empty
    // (it never survived the restart) — the exact production scenario.
    const chat: ChatState = {
        resource: "ahp-chat:/55555555-5555-5555-8555-555555555555",
        title: "Reconciliation",
        status: 33,
        modifiedAt: "2026-08-10T00:00:00.000Z",
        turns: [],
        queuedMessages: [
            {
                id: "ghost-1",
                message: { text: "orphaned after restart", origin: { kind: "user" } },
            },
        ],
    } as unknown as ChatState;

    const projection = createQueueProjectionState();
    seedQueueProjection(projection, chat);

    // The host reports an empty queue for this session (attach()/subscribeLive()
    // truth) — projectQueue diffs it against the seeded ids and must emit a
    // removal for the row the host never tracked.
    const actions = projectQueue(projection, []);
    let next = chat;
    for (const item of actions) {
        if (item.channel === "chat") {
            next = chatReducer(next, item.action as never);
        }
    }

    assert.equal(next.queuedMessages, undefined, "the ghost row is gone once host truth arrives");
});
