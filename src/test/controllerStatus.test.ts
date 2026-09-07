import assert from "node:assert/strict";
import test from "node:test";
import { ControllerEventHandler } from "../application/controllerEventHandler";
import { MISSING_FINAL_RESPONSE_NOTICE } from "../application/finalResponseState";
import { TurnTracker } from "../application/turn";

function handlerState(
    options: {
        observeEvent?: (event: Parameters<ControllerEventHandler["handle"]>[0]) => boolean;
        recoverFailedTurn?: () => boolean;
    } = {},
) {
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
        observeEvent: options.observeEvent,
        takeQueued: () => undefined,
        emitQueue: () => undefined,
        dispatch: () => undefined,
        holdQueue: () => undefined,
        queuedCount: () => 0,
        releaseOwnership: () => ownershipReleases++,
        recoverFailedTurn: options.recoverFailedTurn,
    });
    return { turns, handler, emitted, ownershipReleases: () => ownershipReleases };
}

test("a deferred terminal error is exposed before turn-end when recovery cannot own it", () => {
    const { turns, handler, emitted } = handlerState({
        observeEvent: (event) => event.kind !== "error",
        recoverFailedTurn: () => false,
    });
    const error = { kind: "error", message: "provider stream failed", retryable: true } as const;

    handler.handle(error);
    handler.handle({ kind: "turn-end", durationMs: 47_013 });

    const terminal = emitted.filter(
        (message) =>
            (message as { event?: { kind?: string } }).event?.kind === "error" ||
            (message as { event?: { kind?: string } }).event?.kind === "turn-end",
    ) as Array<{ event: { kind: string; message?: string; durationMs?: number } }>;
    assert.deepEqual(
        terminal.map(({ event }) => event.kind),
        ["error", "turn-end"],
    );
    assert.equal(terminal[0].event.message, error.message);
    assert.equal(terminal[1].event.durationMs, 47_013);
    assert.equal(turns.lastTurn?.outcome, "failed");
    assert.equal(turns.lastTurn?.takeError(), undefined);
});

test("automatic recovery keeps its deferred raw error hidden", () => {
    const { handler, emitted } = handlerState({
        observeEvent: (event) => event.kind !== "error",
        recoverFailedTurn: () => true,
    });

    handler.handle({ kind: "error", message: "HTTP 503", retryable: true });
    handler.handle({ kind: "turn-end" });

    assert.equal(
        emitted.some(
            (message) => (message as { event?: { kind?: string } }).event?.kind === "error",
        ),
        false,
    );
    assert.equal(
        emitted.filter(
            (message) => (message as { event?: { kind?: string } }).event?.kind === "turn-end",
        ).length,
        1,
    );
});

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
