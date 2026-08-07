import assert from "node:assert/strict";
import test from "node:test";
import { ControllerEventHandler } from "../application/controllerEventHandler";

function handlerState() {
    const state = { busy: true, warning: false, error: false };
    const handler = new ControllerEventHandler({
        isBusy: () => state.busy,
        setBusy: (value) => {
            state.busy = value;
        },
        armWatchdog: () => undefined,
        clearWatchdog: () => undefined,
        emit: () => undefined,
        statusChanged: () => undefined,
        recordChanged: () => undefined,
        setTodos: () => undefined,
        trackingMode: () => undefined,
        markTurnFailed: () => {
            state.error = true;
        },
        markTurnWarning: () => {
            state.warning = true;
        },
        setLogicalTurnId: () => undefined,
        takeQueued: () => undefined,
        emitQueue: () => undefined,
        dispatch: () => undefined,
        turnFailed: () => state.error,
    });
    return { state, handler };
}

test("terminal warning marks a stopped session for attention", () => {
    const { state, handler } = handlerState();
    handler.handle({ kind: "status-notice", severity: "warning", terminal: true, text: "stopped" });
    handler.handle({ kind: "turn-end" });
    assert.equal(state.warning, true);
    assert.equal(state.busy, false);
});

test("non-terminal warnings do not mark the session as stopped", () => {
    const { state, handler } = handlerState();
    handler.handle({ kind: "status-notice", severity: "warning", text: "still running" });
    assert.equal(state.warning, false);
});
