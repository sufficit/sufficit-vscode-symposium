import assert from "node:assert/strict";
import test from "node:test";
import { ControllerClientActions } from "../application/controllerClientActions";
import { ChatQueue } from "../application/controllerQueue";
import type { PeerQueueCommand } from "../application/controllerPeerQueue";
import type { TurnTracker } from "../application/turn";

test("follower forwards Send next without rewriting the owner's queue snapshot", () => {
    const queue = heldQueue();
    const commands: PeerQueueCommand[] = [];
    const actions = createActions(queue, {
        canMutateQueue: false,
        commands,
        dispatch: () => assert.fail("a follower cannot dispatch the native session"),
    });

    assert.equal(actions.promoteQueued("queued-1"), true);
    assert.equal(queue.length, 1, "the follower waits for the authoritative owner snapshot");
    assert.equal(queue.isHeld, true);
    assert.deepEqual(commands, [{ type: "queue-command", action: "promote", id: "queued-1" }]);
});

test("owner Send next releases a failed hold and dispatches exactly that message", () => {
    const queue = heldQueue();
    const dispatched: string[] = [];
    let snapshots = 0;
    const actions = createActions(queue, {
        canMutateQueue: true,
        commands: [],
        dispatch: (text) => dispatched.push(text),
        emitQueue: () => snapshots++,
    });

    assert.equal(actions.promoteQueued("queued-1"), true);
    assert.equal(queue.isHeld, false);
    assert.equal(queue.isEmpty, true);
    assert.deepEqual(dispatched, ["continue"]);
    assert.equal(snapshots, 1);
});

function heldQueue(): ChatQueue {
    const queue = new ChatQueue();
    queue.restore([
        {
            id: 1,
            clientMessageId: "queued-1",
            text: "continue",
            attachments: [],
        },
    ]);
    queue.hold({ reason: "turn-failed", turnId: "failed-turn", at: 1 });
    return queue;
}

function createActions(
    queue: ChatQueue,
    options: {
        canMutateQueue: boolean;
        commands: PeerQueueCommand[];
        dispatch(text: string): void;
        emitQueue?: () => void;
    },
): ControllerClientActions {
    return new ControllerClientActions({
        queue,
        getSession: () => undefined,
        turns: { isBusy: false } as TurnTracker,
        statusChanged: () => undefined,
        onSend: () => assert.fail("not used"),
        emitQueue: options.emitQueue ?? (() => assert.fail("a follower waits for owner state")),
        dispatch: (message) => options.dispatch(message.text),
        canMutateQueue: () => options.canMutateQueue,
        emitPeerQueueCommand: (command) => options.commands.push(command),
    });
}
