import assert from "node:assert/strict";
import test from "node:test";
import { ControllerEventHandler } from "../application/controllerEventHandler";
import { TurnTracker } from "../application/turn";

function handlerState() {
    const turns = new TurnTracker();
    turns.begin("user");
    const handler = new ControllerEventHandler({
        turns,
        armWatchdog: () => undefined,
        clearWatchdog: () => undefined,
        emit: () => undefined,
        statusChanged: () => undefined,
        recordChanged: () => undefined,
        setTodos: () => undefined,
        trackingMode: () => undefined,
        takeQueued: () => undefined,
        emitQueue: () => undefined,
        dispatch: () => undefined,
        holdQueue: () => undefined,
        queuedCount: () => 0,
    });
    return { turns, handler };
}

test("terminal warning marks a stopped session for attention", () => {
    const { turns, handler } = handlerState();
    handler.handle({ kind: "status-notice", severity: "warning", terminal: true, text: "stopped" });
    handler.handle({ kind: "turn-end" });
    assert.equal(turns.attention, "warning");
    assert.equal(turns.isBusy, false);
});

test("non-terminal warnings do not mark the session as stopped", () => {
    const { turns, handler } = handlerState();
    handler.handle({ kind: "status-notice", severity: "warning", text: "still running" });
    // Still live — attention is hidden while busy regardless, but the
    // underlying turn must not have recorded it either.
    assert.equal(turns.current?.attention, undefined);
});
