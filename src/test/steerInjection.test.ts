import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, InjectedUserMessage } from "../adapters/types";
import { ChatQueue, MessageDedup, type PendingMessage } from "../application/controllerQueue";
import { routeControllerSend } from "../application/controllerSendRouter";
import { requeueDroppedSteer } from "../application/controllerSteerInjection";
import { TurnTracker } from "../application/turn";

interface Harness {
    queue: ChatQueue;
    emitted: unknown[];
    queueEmits: number;
    offers: InjectedUserMessage[];
    cancelled: boolean;
    dispatched: string[];
    context: Parameters<typeof routeControllerSend>[2];
}

/** Router context for a live openai-shaped session with a running turn. */
function harness(options: { injectable?: boolean } = {}): Harness {
    const injectable = options.injectable !== false;
    const turns = new TurnTracker();
    turns.begin("user");
    const state = {
        queue: new ChatQueue(),
        emitted: [] as unknown[],
        queueEmits: 0,
        offers: [] as InjectedUserMessage[],
        cancelled: false,
        dispatched: [] as string[],
    };
    const session = {
        ...(injectable
            ? {
                  injectUserMessage: (message: InjectedUserMessage) => {
                      state.offers.push(message);
                      return true;
                  },
              }
            : {}),
    } as unknown as AgentSession;
    return {
        ...state,
        get queueEmits() {
            return state.queueEmits;
        },
        context: {
            queue: state.queue,
            dedup: new MessageDedup(),
            busy: () => true,
            cancel: () => {
                state.cancelled = true;
            },
            dispatch: (message: PendingMessage) => state.dispatched.push(message.text),
            emitQueue: () => {
                state.queueEmits++;
            },
            getSession: () => session,
            turns,
            createIntentId: () => "intent-1",
            emit: (message: unknown) => state.emitted.push(message),
        },
    } as unknown as Harness;
}

test("steer is injected into the running turn instead of queued", () => {
    const h = harness();

    routeControllerSend(
        { text: "use gh instead", attachments: [], clientMessageId: "c1" },
        "steer",
        h.context,
    );

    assert.equal(h.offers.length, 1);
    assert.equal(h.offers[0].text, "use gh instead");
    assert.equal(h.offers[0].intentId, "intent-1");
    assert.equal(h.queue.isEmpty, true, "an injected steer is not a pending item");
    assert.equal(h.queueEmits, 0, "no queue snapshot for a message that never queued");
    assert.equal(h.cancelled, false, "steer never cancels the turn");
    assert.deepEqual(h.dispatched, []);
});

test("committing an injection emits the user row that persists and renders it", () => {
    const h = harness();
    routeControllerSend(
        { text: "use gh instead", attachments: [], clientMessageId: "c1" },
        "steer",
        h.context,
    );

    h.offers[0].onCommitted?.("turn-7");

    assert.deepEqual(h.emitted, [
        { type: "user", text: "use gh instead", attachments: [], clientMessageId: "c1" },
    ]);
});

test("a dropped injection falls back to the queue instead of vanishing", () => {
    const h = harness();
    routeControllerSend(
        { text: "late", attachments: [], clientMessageId: "c1" },
        "steer",
        h.context,
    );

    h.offers[0].onDropped?.("turn-ended");

    assert.deepEqual(
        h.queue.items().map((i) => i.text),
        ["late"],
    );
    assert.equal(h.queueEmits, 1);
});

test("a backend without injectUserMessage keeps head-of-queue steer", () => {
    const h = harness({ injectable: false });

    routeControllerSend(
        { text: "steered", attachments: [], clientMessageId: "c1" },
        "steer",
        h.context,
    );

    assert.equal(h.offers.length, 0);
    assert.deepEqual(
        h.queue.items().map((i) => i.text),
        ["steered"],
    );
    assert.equal(h.cancelled, false);
});

test("a steer carrying attachments falls back to the queue", () => {
    const h = harness();

    routeControllerSend(
        { text: "look at this", attachments: ["/tmp/a.png"], clientMessageId: "c1" },
        "steer",
        h.context,
    );

    assert.equal(h.offers.length, 0, "attachments need the full dispatch assembly");
    assert.deepEqual(
        h.queue.items().map((i) => i.text),
        ["look at this"],
    );
});

test("dedup still gates before injection is offered", () => {
    const h = harness();
    const send = () =>
        routeControllerSend(
            { text: "same", attachments: [], clientMessageId: "dup" },
            "steer",
            h.context,
        );

    send();
    send();

    assert.equal(h.offers.length, 1);
});

test("a superseded drop queues behind the intent that took over", () => {
    const queue = new ChatQueue();
    queue.enqueue({ text: "the redirect", attachments: [] });
    let emits = 0;
    const ctx = { queue, emitQueue: () => emits++ };

    requeueDroppedSteer({ text: "steered", attachments: [] }, "superseded", ctx);

    assert.deepEqual(
        queue.items().map((i) => i.text),
        ["the redirect", "steered"],
    );
    assert.equal(emits, 1);
});

test("a turn-ended drop keeps the steer at the head", () => {
    const queue = new ChatQueue();
    queue.enqueue({ text: "already waiting", attachments: [] });

    requeueDroppedSteer({ text: "steered", attachments: [] }, "turn-ended", {
        queue,
        emitQueue: () => {},
    });

    assert.deepEqual(
        queue.items().map((i) => i.text),
        ["steered", "already waiting"],
    );
});
