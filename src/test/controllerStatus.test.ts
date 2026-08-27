import assert from "node:assert/strict";
import test from "node:test";
import { ControllerEventHandler } from "../application/controllerEventHandler";
import { MISSING_FINAL_RESPONSE_NOTICE } from "../application/finalResponseState";
import { TurnTracker } from "../application/turn";

function handlerState() {
    const turns = new TurnTracker();
    turns.begin("user");
    let ownershipReleases = 0;
    const emitted: unknown[] = [];
    const handler = new ControllerEventHandler({
        turns,
        armWatchdog: () => undefined,
        clearWatchdog: () => undefined,
        emit: (message) => emitted.push(message),
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
    return { turns, handler, emitted, ownershipReleases: () => ownershipReleases };
}

test("terminal warning marks a stopped session for attention and releases idle ownership", () => {
    const { turns, handler, ownershipReleases } = handlerState();
    handler.handle({ kind: "status-notice", severity: "warning", terminal: true, text: "stopped" });
    handler.handle({ kind: "turn-end" });
    assert.equal(turns.attention, "warning");
    assert.equal(turns.isBusy, false);
    assert.equal(ownershipReleases(), 1);
});

test("a completed turn without a final assistant response leaves a durable warning", () => {
    const { turns, handler, emitted } = handlerState();
    handler.handle({ kind: "tool-start", toolName: "exec" });
    handler.handle({ kind: "tool-end", toolName: "exec", result: "done" });
    handler.handle({ kind: "turn-end" });

    const notice = emitted.find(
        (message) => (message as { event?: { kind?: string } }).event?.kind === "status-notice",
    ) as { event?: { terminal?: boolean; severity?: string; text?: string } } | undefined;
    assert.equal(notice?.event?.terminal, true);
    assert.equal(notice?.event?.severity, "warning");
    assert.match(notice?.event?.text ?? "", /without returning a final response/);
    assert.equal(turns.attention, "warning");
});

test("assistant text after the last tool completes normally without a warning", () => {
    const { handler, emitted } = handlerState();
    handler.handle({ kind: "tool-start", toolName: "exec" });
    handler.handle({ kind: "tool-end", toolName: "exec" });
    handler.handle({ kind: "text", text: "Final result" });
    handler.handle({ kind: "turn-end" });

    assert.equal(
        emitted.some(
            (message) => (message as { event?: { kind?: string } }).event?.kind === "status-notice",
        ),
        false,
    );
});

test("a terminal TodoWrite snapshot does not invalidate the final assistant response", () => {
    const { turns, handler, emitted } = handlerState();
    handler.handle({ kind: "text", text: "Implemented and validated." });
    handler.handle({ kind: "tool-start", toolName: "TodoWrite", detail: "", todos: [] });
    handler.handle({ kind: "turn-end" });

    assert.equal(
        emitted.some(
            (message) =>
                (message as { event?: { text?: string } }).event?.text ===
                MISSING_FINAL_RESPONSE_NOTICE,
        ),
        false,
    );
    assert.equal(turns.attention, undefined);
});

test("a substantive tool after assistant text still requires a final response", () => {
    const { turns, handler, emitted } = handlerState();
    handler.handle({ kind: "text", text: "I will inspect it." });
    handler.handle({ kind: "tool-start", toolName: "exec", detail: "check" });
    handler.handle({ kind: "tool-end", toolName: "exec", detail: "check" });
    handler.handle({ kind: "turn-end" });

    assert.equal(
        emitted.some(
            (message) =>
                (message as { event?: { text?: string } }).event?.text ===
                MISSING_FINAL_RESPONSE_NOTICE,
        ),
        true,
    );
    assert.equal(turns.attention, "warning");
});

test("non-terminal warnings do not mark the session as stopped", () => {
    const { turns, handler } = handlerState();
    handler.handle({ kind: "status-notice", severity: "warning", text: "still running" });
    // Still live — attention is hidden while busy regardless, but the
    // underlying turn must not have recorded it either.
    assert.equal(turns.current?.attention, undefined);
});
