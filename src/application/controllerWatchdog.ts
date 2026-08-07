/** Application turn watchdog.
 *
 * Silence watchdog: force-ends a turn that produces no events for too long, so a
 * stalled tool call or dropped backend connection can't pin the session as
 * "working" forever (it survives reloads since the controller outlives them).
 * Reset by every event, so long but active tools/streams are unaffected.
 *
 * Extracted from ChatController as free functions over a context bag. The
 * stalled-turn recovery touches several controller fields (busy flag, session
 * cancel, status change), so they're exposed on the bag.
 */
export interface WatchdogContext {
    busy(): boolean;
    setBusy(value: boolean): void;
    /** Records the forced stop as a failed turn so a late backend turn-end
     *  cannot drain a queued user message as though the turn succeeded. */
    markTurnFailed(): void;
    cancel(): void;
    onStatusChange?(): void;
    emit(message: unknown): void;
    /** Minutes of silence before a stalled turn is force-ended (symposium.turnSilenceMinutes);
     *  read fresh on every arm so a live settings change applies to the next turn. <= 0 disables it. */
    silenceMinutes(): number;
}

/** (Re)arms the silence watchdog; no-op when idle or when disabled (silenceMinutes <= 0). */
export function armWatchdog(
    ctx: WatchdogContext,
    state: { timer: ReturnType<typeof setTimeout> | undefined },
): void {
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
    }
    if (!ctx.busy()) {
        return;
    }
    const minutes = ctx.silenceMinutes();
    if (minutes <= 0) {
        return;
    }
    state.timer = setTimeout(() => forceEndStalledTurn(ctx, state, minutes), minutes * 60 * 1000);
}

export function clearWatchdog(state: { timer: ReturnType<typeof setTimeout> | undefined }): void {
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
    }
}

/** Recovers a turn that produced no events for `minutes` minutes. Leaves any
 *  queued message alone — a forced stall is a failure, not a normal
 *  continuation point, so the user chooses Retry or explicitly promotes/steers
 *  the queue instead of it silently auto-firing next. */
export function forceEndStalledTurn(
    ctx: WatchdogContext,
    state: { timer: ReturnType<typeof setTimeout> | undefined },
    minutes: number,
): void {
    if (!ctx.busy()) {
        return;
    }
    ctx.setBusy(false);
    ctx.markTurnFailed();
    clearWatchdog(state);
    ctx.cancel();
    ctx.onStatusChange?.();
    ctx.emit({
        type: "event",
        event: {
            kind: "error",
            message: `Turn ended automatically: no activity from the agent for ${minutes} minute${minutes === 1 ? "" : "s"} (likely a stalled tool or dropped connection).`,
            retryable: true,
        },
    });
    ctx.emit({ type: "event", event: { kind: "turn-end" } });
}
