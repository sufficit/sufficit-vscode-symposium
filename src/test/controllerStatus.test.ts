import assert from "node:assert/strict";
import test from "node:test";
import { ControllerEventHandler } from "../application/controllerEventHandler";
import { TurnTracker } from "../application/turn";

function handlerState() {
    const turns = new TurnTracker();
    turns.begin("user");
    let ownershipReleases = 0;
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
        releaseOwnership: () => ownershipReleases++,
    });
    return { turns, handler, ownershipReleases: () => ownershipReleases };
}

test("terminal warning marks a stopped session for attention and releases idle ownership", () => {
    const { turns, handler, ownershipReleases } = handlerState();
    handler.handle({ kind: "status-notice", severity: "warning", terminal: true, text: "stopped" });
    handler.handle({ kind: "turn-end" });
    assert.equal(turns.attention, "warning");
    assert.equal(turns.isBusy, false);
    assert.equal(ownershipReleases(), 1);
});

test("non-terminal warnings do not mark the session as stopped", () => {
    const { turns, handler } = handlerState();
    handler.handle({ kind: "status-notice", severity: "warning", text: "still running" });
    // Still live — attention is hidden while busy regardless, but the
    // underlying turn must not have recorded it either.
    assert.equal(turns.current?.attention, undefined);
});
