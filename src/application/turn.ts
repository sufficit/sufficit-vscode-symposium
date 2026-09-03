/**
 * A "turn" is one request→response cycle with an AI backend. Before this file
 * existed, turn state was scattered as loose fields on ControllerLiveState
 * (`busy`, `attentionStatus`, `lastLogicalTurnId`) plus ad hoc flags bolted
 * onto ChatQueue (`held`) and CodexSession (`turnEndEmitted`), each added as
 * a bug surfaced rather than designed up front. That shape caused real bugs:
 * a duplicate/stray turn-end could re-drain the queue, a failed turn's queued
 * messages could silently auto-fire out of order later, and a stalled turn
 * force-ended by the watchdog bypassed the queue-hold policy entirely (it
 * never went through the reducer that applies it).
 *
 * Turn + TurnTracker make "only one live turn at a time" and "an end event
 * must be correlated to the turn it's ending" structural instead of
 * reconstructed via optional-field comparisons scattered across the event
 * handler.
 */
import type { AgentEvent, SessionTerminalStatus } from "../adapters/types";

type TurnErrorEvent = Extract<AgentEvent, { kind: "error" }>;

/** pending = created by dispatch, not yet handed to the backend.
 *  running = the backend has the message (or emitted turn-start).
 *  ended   = terminal; `outcome` is frozen. */
export type TurnPhase = "pending" | "running" | "ended";

export type TurnOutcome = "completed" | "failed" | "cancelled" | "superseded";

/** Why this turn was started — logging/observability only, no policy hangs off it. */
export type TurnOrigin = "user" | "queue" | "retry" | "continue";

export interface TurnInit {
    id: string;
    origin: TurnOrigin;
    startedAt: number;
    intentId?: string;
    /** Compatibility metadata; retries now allocate a fresh backend id so
     *  stale events cannot end the new attempt. */
    expectedBackendId?: string;
}

export class Turn {
    readonly id: string;
    readonly origin: TurnOrigin;
    readonly startedAt: number;
    readonly intentId: string | undefined;
    readonly expectedBackendId: string | undefined;

    private _backendId: string | undefined;
    private _phase: TurnPhase = "pending";
    private _outcome: TurnOutcome | undefined;
    private _attention: SessionTerminalStatus | undefined;
    /**
     * The terminal provider error belongs to the turn, not to the retry
     * controller. `visible` is false while automatic recovery deliberately
     * defers the raw card. Keeping the event here prevents an internal retry
     * state mismatch from swallowing the only explanation shown to the user.
     */
    private _hiddenError: TurnErrorEvent | undefined;
    private _cancelRequested = false;
    private _endedAt: number | undefined;
    // A completed turn needs a final assistant response after its last tool.
    // Without this bit, a provider that simply closes after a tool/result is
    // indistinguishable from a healthy answer and the UI goes idle silently.
    private _awaitingFinalResponse = true;

    constructor(init: TurnInit) {
        this.id = init.id;
        this.origin = init.origin;
        this.startedAt = init.startedAt;
        this.intentId = init.intentId;
        this.expectedBackendId = init.expectedBackendId;
    }

    get backendId(): string | undefined {
        return this._backendId;
    }

    get phase(): TurnPhase {
        return this._phase;
    }

    get isLive(): boolean {
        return this._phase !== "ended";
    }

    get outcome(): TurnOutcome | undefined {
        return this._outcome;
    }

    get attention(): SessionTerminalStatus | undefined {
        return this._attention;
    }

    get cancelRequested(): boolean {
        return this._cancelRequested;
    }

    get awaitingFinalResponse(): boolean {
        return this._awaitingFinalResponse;
    }

    get durationMs(): number | undefined {
        return this._endedAt !== undefined ? this._endedAt - this.startedAt : undefined;
    }

    /** THE queue-hold decision, owned here. A failed turn is not a normal
     *  continuation point, so its queue must not auto-drain. Frozen at end(). */
    get holdsQueue(): boolean {
        return this._outcome === "failed";
    }

    /** Binds the backend's logicalTurnId. Returns "bound" on first bind,
     *  "same" when it matches, "rebound" when it replaces a different id
     *  (caller should retire the previous one and log). */
    bindBackendId(id: string): "bound" | "same" | "rebound" {
        if (this._backendId === undefined) {
            this._backendId = id;
            return "bound";
        }
        if (this._backendId === id) {
            return "same";
        }
        this._backendId = id;
        return "rebound";
    }

    /** pending → running. Called right after session.send()/continueTurn(). */
    markSent(): void {
        if (this._phase === "pending") {
            this._phase = "running";
        }
    }

    /** Sticky; error wins over warning. Legal after end() — it then only
     *  affects the session badge, never `holdsQueue` (outcome is frozen). */
    recordError(event?: TurnErrorEvent, visible = true): void {
        this._attention = "error";
        if (event) this._hiddenError = visible ? undefined : event;
    }

    takeError(): TurnErrorEvent | undefined {
        const event = this._hiddenError;
        this._hiddenError = undefined;
        return event;
    }

    recordWarning(): void {
        if (this._attention !== "error") {
            this._attention = "warning";
        }
    }

    recordAssistantText(): void {
        this._awaitingFinalResponse = false;
    }

    recordToolActivity(): void {
        this._awaitingFinalResponse = true;
    }

    requestCancel(): void {
        this._cancelRequested = true;
    }

    /** Idempotent. Returns false if already ended (so callers can detect a
     *  double-termination without branching on phase). When `outcome` is
     *  omitted it is derived: error → "failed", else cancelRequested →
     *  "cancelled", else "completed". Order matters: a cancel that produced a
     *  real error still holds the queue (matches historical behaviour), while
     *  a clean cancel drains it (redirect relies on the cancelled turn's end
     *  dispatching the correction it put at the queue head). */
    end(outcome?: TurnOutcome, at: number = Date.now()): boolean {
        if (this._phase === "ended") {
            return false;
        }
        this._phase = "ended";
        this._endedAt = at;
        this._outcome =
            outcome ??
            (this._attention === "error"
                ? "failed"
                : this._cancelRequested
                  ? "cancelled"
                  : "completed");
        return true;
    }

    describe(): string {
        return `${this.id}[${this._phase}]${this._outcome ? `(${this._outcome})` : ""} backend=${this._backendId ?? "none"} attention=${this._attention ?? "none"} origin=${this.origin}`;
    }
}

export type TurnEndDecision =
    | { accept: true; turn: Turn }
    | { accept: false; reason: "no-live-turn" | "stale-id" };

export type TurnStartDecision =
    | { accept: true; turn: Turn }
    | { accept: false; reason: "no-live-turn" | "stale-id" };

export interface TurnTrackerDeps {
    log?: (message: string) => void;
    now?: () => number;
}

const MAX_RETIRED = 8;

/** Owns the "exactly one live turn" invariant and all end-event correlation. */
export class TurnTracker {
    private _current: Turn | undefined;
    private _lastTurn: Turn | undefined;
    private seq = 0;
    /** Backend ids of turns that have ended — a late event carrying one of
     *  these belongs to a superseded turn, not the live one. */
    private readonly retired: string[] = [];

    constructor(private readonly deps: TurnTrackerDeps = {}) {}

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    get current(): Turn | undefined {
        return this._current;
    }

    get lastTurn(): Turn | undefined {
        return this._lastTurn;
    }

    get isBusy(): boolean {
        return this._current !== undefined;
    }

    /** Session badge. Derived, never stored: while a turn is live there is no
     *  attention (the sessions list already shows "working"), and once it
     *  ends the last turn's attention is the badge. */
    get attention(): SessionTerminalStatus | undefined {
        return this._current ? undefined : this._lastTurn?.attention;
    }

    /** Replaces the old lastLogicalTurnId field (used by Retry). */
    get lastBackendTurnId(): string | undefined {
        return this._current?.backendId ?? this._lastTurn?.backendId;
    }

    private retire(backendId: string | undefined): void {
        if (!backendId) return;
        this.retired.push(backendId);
        if (this.retired.length > MAX_RETIRED) {
            this.retired.shift();
        }
    }

    /** Starts a turn. If one is already live it is force-ended as
     *  "superseded" and logged — the invariant is enforced, not asserted.
     *  Retired backend ids stay retired so late events from a failed attempt
     *  cannot be mistaken for the next retry. */
    begin(origin: TurnOrigin, init?: { intentId?: string; expectedBackendId?: string }): Turn {
        if (this._current) {
            this.deps.log?.(
                `[turn] ${this._current.describe()} superseded by a new turn before it ended`,
            );
            this.end(this._current, "superseded");
        }
        const turn = new Turn({
            id: `t${++this.seq}`,
            origin,
            startedAt: this.now(),
            intentId: init?.intentId,
            expectedBackendId: init?.expectedBackendId,
        });
        this._current = turn;
        this.deps.log?.(`[turn] begin ${turn.describe()}`);
        return turn;
    }

    /** Correlation for turn-end. */
    resolveEnd(eventTurnId: string | undefined): TurnEndDecision {
        const turn = this._current;
        if (!turn) {
            return { accept: false, reason: "no-live-turn" };
        }
        if (eventTurnId) {
            if (this.retired.includes(eventTurnId)) {
                return { accept: false, reason: "stale-id" };
            }
            if (turn.backendId !== undefined && turn.backendId !== eventTurnId) {
                return { accept: false, reason: "stale-id" };
            }
            if (turn.backendId === undefined) {
                turn.bindBackendId(eventTurnId);
            }
        }
        return { accept: true, turn };
    }

    /** Correlation for turn-start; binds/rebinds the backend id on accept. */
    resolveStart(eventTurnId: string): TurnStartDecision {
        const turn = this._current;
        if (!turn) {
            return { accept: false, reason: "no-live-turn" };
        }
        if (this.retired.includes(eventTurnId)) {
            return { accept: false, reason: "stale-id" };
        }
        const result = turn.bindBackendId(eventTurnId);
        if (result === "rebound") {
            this.deps.log?.(`[turn] ${turn.id} rebound backend id to ${eventTurnId}`);
        }
        return { accept: true, turn };
    }

    /** Ends `turn` (idempotent), retires its backend id, moves it to lastTurn. */
    end(turn: Turn, outcome?: TurnOutcome): boolean {
        const changed = turn.end(outcome, this.now());
        if (!changed) {
            return false;
        }
        this.retire(turn.backendId);
        if (this._current === turn) {
            this._current = undefined;
        }
        this._lastTurn = turn;
        this.deps.log?.(`[turn] end ${turn.describe()}`);
        return true;
    }

    /** Marks the live turn cancel-requested (steer/redirect/interrupt). */
    requestCancel(): void {
        this._current?.requestCancel();
    }
}
