import { ChatQueue, PendingMessage } from "./controllerQueue";

/**
 * Silence watchdog: force-ends a turn that produces no events for too long, so a
 * stalled tool call or dropped backend connection can't pin the session as
 * "working" forever (it survives reloads since the controller outlives them).
 * Reset by every event, so long but active tools/streams are unaffected.
 *
 * Extracted from ChatController as free functions over a context bag. The
 * stalled-turn recovery touches several controller fields (busy flag, session
 * cancel, status change, queue drain, dispatch), so they're exposed on the bag.
 */
export interface WatchdogContext {
    busy(): boolean;
    setBusy(value: boolean): void;
    cancel(): void;
    onStatusChange?(): void;
    emit(message: unknown): void;
    queue: ChatQueue;
    emitQueue(): void;
    dispatch(message: PendingMessage): void;
}

/** How long with no backend activity before a turn is force-ended. */
export const TURN_SILENCE_MS = 5 * 60 * 1000;

/** (Re)arms the silence watchdog; no-op when idle. */
export function armWatchdog(ctx: WatchdogContext, state: { timer: ReturnType<typeof setTimeout> | undefined }): void {
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    if (!ctx.busy()) { return; }
    state.timer = setTimeout(() => forceEndStalledTurn(ctx, state), TURN_SILENCE_MS);
}

export function clearWatchdog(state: { timer: ReturnType<typeof setTimeout> | undefined }): void {
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
}

/** Recovers a turn that produced no events for TURN_SILENCE_MS. */
export function forceEndStalledTurn(ctx: WatchdogContext, state: { timer: ReturnType<typeof setTimeout> | undefined }): void {
    if (!ctx.busy()) { return; }
    ctx.setBusy(false);
    clearWatchdog(state);
    ctx.cancel();
    ctx.onStatusChange?.();
    ctx.emit({ type: "event", event: { kind: "error", message: "Turn ended automatically: no activity from the agent for 5 minutes (likely a stalled tool or dropped connection)." } });
    ctx.emit({ type: "event", event: { kind: "turn-end" } });
    const next = ctx.queue.shift();
    if (next) { ctx.emitQueue(); ctx.dispatch(next); }
}
