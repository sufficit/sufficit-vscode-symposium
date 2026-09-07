import type { AgentEvent } from "../adapters/types";
import type { PendingMessage } from "../application/controllerQueue";
import type { ClockPort, ConfigurationPort } from "../application/ports";
import type { Turn } from "../application/turn";
import { conciseRetryReason } from "./retryReason";
import {
    MAXIMUM_RETRY_DELAY_MILLISECONDS,
    normalizeAttempt,
    readRetryPolicy,
} from "./transientRetryPolicy";
export { conciseRetryReason } from "./retryReason";
export {
    DEFAULT_RETRY_INITIAL_DELAY_MILLISECONDS,
    DEFAULT_TRANSIENT_RETRY_LIMIT,
    MAXIMUM_RETRY_DELAY_MILLISECONDS,
} from "./transientRetryPolicy";

interface DeferredRetryError {
    event: Extract<AgentEvent, { kind: "error" }>;
    limit: number;
    initialDelayMilliseconds: number;
}

interface ScheduledRetry {
    id: string;
    attempt: number;
    limit: number;
    reason: string;
}

interface ActiveAttempt {
    turn: Turn;
    message: PendingMessage;
    attempt: number;
    recoveryAcknowledged: boolean;
    outputStarted: boolean;
    toolStarted: boolean;
    deferred?: DeferredRetryError;
    exhausted?: Extract<AgentEvent, { kind: "error" }>;
}

export interface TransientRetryDeps {
    clock: ClockPort;
    configuration: ConfigurationPort;
    emit(message: unknown): void;
    dispatch(message: PendingMessage): void;
    statusChanged(): void;
    log?(message: string): void;
}

/**
 * Controller-owned transient recovery. It mirrors the Genius policy: retry only
 * failures explicitly classified as transient, use bounded exponential backoff,
 * and never replay a turn after standalone user-visible output started. Tool
 * activity is governed separately by the explicit idempotency preference.
 */
export class TransientRetryController {
    private active: ActiveAttempt | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private scheduled: ScheduledRetry | undefined;
    private _pending = false;

    constructor(private readonly deps: TransientRetryDeps) {}

    get pending(): boolean {
        return this._pending;
    }

    begin(turn: Turn, message: PendingMessage): void {
        this.active = {
            turn,
            message: cloneMessage(message),
            attempt: normalizeAttempt(message.automaticRetryAttempt),
            recoveryAcknowledged: false,
            outputStarted: false,
            toolStarted: false,
        };
    }

    /**
     * Rehydrates the in-memory boundary after an Extension Host hand-off.
     * Render persistence keeps the turn alive across hosts, but the retry
     * controller itself is intentionally process-local. Without this bridge a
     * retryable error from a resumed live turn was rendered normally and could
     * never reach `recover()` with the original request metadata.
     */
    ensureForTurn(turn: Turn, message: PendingMessage): boolean {
        if (this.active?.turn === turn) return false;
        if (this.active) return false;
        this.begin(turn, message);
        const active = this.active as ActiveAttempt | undefined;
        if (!active) return false;
        active.outputStarted = turn.assistantOutputStarted;
        active.toolStarted = turn.toolActivityStarted;
        this.deps.log?.(`[retry] rehydrated controller state for ${turn.describe()}`);
        return true;
    }

    /** Returns false when the raw event must be deferred while recovery runs. */
    observe(event: AgentEvent): boolean {
        const active = this.active;
        if (!active || active.turn.phase === "ended") return true;

        this.acknowledgeRecovery(active, event);
        if (startsUnsafeOutput(event)) {
            active.outputStarted = true;
            this.flushDeferred(active);
        }
        if (startsToolActivity(event)) active.toolStarted = true;

        if (
            event.kind !== "error" ||
            event.fatal === false ||
            event.retryable !== true ||
            event.automaticRetry === false
        ) {
            return true;
        }

        const policy = readRetryPolicy(this.deps.configuration);
        if (retryBlocked(active, policy.afterToolActivity)) {
            this.deps.log?.(
                `[retry] not scheduled: ${retryBlockReason(active, policy.afterToolActivity)}`,
            );
            return true;
        }
        if (active.attempt >= policy.limit) {
            if (active.attempt > 0) active.exhausted = event;
            return true;
        }

        active.deferred = {
            event,
            limit: policy.limit,
            initialDelayMilliseconds: policy.initialDelayMilliseconds,
        };
        return false;
    }

    /**
     * Schedules the next attempt and returns true when normal failed-turn queue
     * handling must pause. The original user row is preserved and not emitted
     * again because the retry carries interruptedBy.
     */
    recover(turn: Turn): boolean {
        const active = this.active;
        if (!active || active.turn !== turn) return false;
        this.active = undefined;

        if (turn.outcome === "completed" && active.attempt > 0 && !active.recoveryAcknowledged) {
            this.emitRecovery(
                active.message.automaticRetryId ?? retryIdentity(active),
                "recovered",
                active.attempt,
                readRetryPolicy(this.deps.configuration).limit,
            );
            return false;
        }

        if (active.exhausted) {
            this.emitRecovery(
                active.message.automaticRetryId ?? retryIdentity(active),
                "exhausted",
                active.attempt,
                readRetryPolicy(this.deps.configuration).limit,
                conciseRetryReason(active.exhausted.message),
            );
            return false;
        }

        const deferred = active.deferred;
        const policy = readRetryPolicy(this.deps.configuration);
        const blocked = retryBlocked(active, policy.afterToolActivity);
        if (!deferred || blocked || turn.outcome !== "failed") {
            if (!deferred) this.deps.log?.("[retry] not scheduled: no deferred retryable error");
            else if (blocked) {
                this.deps.log?.(
                    `[retry] not scheduled: ${retryBlockReason(active, policy.afterToolActivity)}`,
                );
            } else {
                this.deps.log?.(
                    `[retry] not scheduled: turn outcome is ${turn.outcome ?? "unknown"}`,
                );
            }
            this.flushDeferred(active);
            return false;
        }

        const attempt = active.attempt + 1;
        const delayMilliseconds = Math.min(
            deferred.initialDelayMilliseconds * 2 ** active.attempt,
            MAXIMUM_RETRY_DELAY_MILLISECONDS,
        );
        const reason = conciseRetryReason(deferred.event.message);
        const retryId = active.message.automaticRetryId ?? retryIdentity(active);
        const retry: PendingMessage = {
            ...cloneMessage(active.message),
            id: undefined,
            clientMessageId: undefined,
            retryOf: turn.backendId ?? turn.id,
            interruptedBy: reason,
            automaticRetryAttempt: attempt,
            automaticRetryId: retryId,
        };

        this._pending = true;
        this.scheduled = { id: retryId, attempt, limit: deferred.limit, reason };
        this.deps.log?.(
            `[retry] transient failure; retry ${attempt}/${deferred.limit} in ${delayMilliseconds} ms: ${reason}`,
        );
        this.emitRecovery(retryId, "scheduled", attempt, deferred.limit, reason, {
            retryAt: this.deps.clock.now() + delayMilliseconds,
            text: retryScheduledText(
                delayMilliseconds,
                attempt,
                deferred.limit,
                this.deps.configuration.language,
            ),
        });
        this.deps.statusChanged();
        this.timer = this.deps.clock.setTimeout(() => {
            this.timer = undefined;
            this._pending = false;
            this.scheduled = undefined;
            this.emitRecovery(retryId, "running", attempt, deferred.limit, reason);
            this.deps.statusChanged();
            this.deps.dispatch(retry);
        }, delayMilliseconds);
        return true;
    }

    cancel(): boolean {
        if (this.timer !== undefined) {
            this.deps.clock.clearTimeout(this.timer);
            this.timer = undefined;
        }
        const scheduled = this.scheduled;
        const changed = this._pending;
        this._pending = false;
        this.scheduled = undefined;
        if (changed) {
            this.deps.log?.("[retry] scheduled automatic retry cancelled by a newer action");
            if (scheduled) {
                this.emitRecovery(
                    scheduled.id,
                    "cancelled",
                    scheduled.attempt,
                    scheduled.limit,
                    scheduled.reason,
                );
            }
            this.active = undefined;
            this.deps.statusChanged();
        }
        return changed;
    }

    /**
     * The transport is recovered as soon as a retry produces real agent
     * progress. Waiting for turn-end can leave a warning spinner alive through
     * minutes of tools and text, and an ephemeral terminal event can be missed
     * by a reconnecting AHP client. Keep the attempt active so a later
     * transient failure can still schedule the next bounded retry.
     */
    private acknowledgeRecovery(active: ActiveAttempt, event: AgentEvent): void {
        if (active.attempt <= 0 || active.recoveryAcknowledged || !startsRetryProgress(event)) {
            return;
        }
        active.recoveryAcknowledged = true;
        this.emitRecovery(
            active.message.automaticRetryId ?? retryIdentity(active),
            "recovered",
            active.attempt,
            readRetryPolicy(this.deps.configuration).limit,
        );
    }

    private flushDeferred(active: ActiveAttempt): void {
        if (!active.deferred) return;
        this.deps.emit({ type: "event", event: active.deferred.event });
        active.turn.takeError();
        active.deferred = undefined;
    }

    private emitRecovery(
        id: string,
        state: "scheduled" | "running" | "recovered" | "cancelled" | "exhausted",
        attempt: number,
        limit: number,
        reason?: string,
        options: { retryAt?: number; text?: string } = {},
    ): void {
        const text =
            options.text ?? retryStateText(state, attempt, limit, this.deps.configuration.language);
        this.deps.emit({
            type: "event",
            event: {
                kind: "status-notice",
                severity:
                    state === "recovered" ? "info" : state === "exhausted" ? "error" : "warning",
                text,
                recovery: { id, state, attempt, limit, reason, retryAt: options.retryAt },
            },
        });
    }
}

function startsUnsafeOutput(event: AgentEvent): boolean {
    if (event.kind === "text") return event.text.trim().length > 0;
    return event.kind === "approval-request" || event.kind === "approval-resolved";
}

function startsToolActivity(event: AgentEvent): boolean {
    return event.kind === "tool-start" || event.kind === "tool-output" || event.kind === "tool-end";
}

function startsRetryProgress(event: AgentEvent): boolean {
    if (event.kind === "text" || event.kind === "thinking") {
        return event.text.trim().length > 0;
    }
    return (
        startsToolActivity(event) ||
        event.kind === "approval-request" ||
        event.kind === "approval-resolved"
    );
}

/** Tool-recovery preference takes precedence over progress narration emitted
 * around that tool. Without it, normal agent commentary made the setting
 * ineffective. Standalone assistant output and approvals remain non-replayable. */
function retryBlocked(active: ActiveAttempt, afterToolActivity: boolean): boolean {
    return active.toolStarted ? !afterToolActivity : active.outputStarted;
}

function retryBlockReason(active: ActiveAttempt, afterToolActivity: boolean): string {
    if (active.toolStarted && !afterToolActivity) {
        return "tool activity is present and recovery-after-tools is disabled";
    }
    if (active.outputStarted) return "standalone assistant output already started";
    return "the retry safety policy blocked this turn";
}

function retryIdentity(active: ActiveAttempt): string {
    return (
        active.message.intentId ?? active.turn.intentId ?? active.turn.backendId ?? active.turn.id
    );
}

function cloneMessage(message: PendingMessage): PendingMessage {
    return { ...message, attachments: [...message.attachments] };
}

function retryScheduledText(
    delayMilliseconds: number,
    attempt: number,
    limit: number,
    language: string,
): string {
    const seconds = Math.max(1, Math.ceil(delayMilliseconds / 1_000));
    if (language.toLowerCase().startsWith("pt")) {
        return `Falha temporária de conexão. Nova tentativa automática em ${seconds} segundo${seconds === 1 ? "" : "s"} (${attempt}/${limit}); a mensagem original não será duplicada.`;
    }
    return `Temporary connection failure. Retrying automatically in ${seconds} second${seconds === 1 ? "" : "s"} (${attempt}/${limit}); the original message will not be duplicated.`;
}

function retryStateText(
    state: "scheduled" | "running" | "recovered" | "cancelled" | "exhausted",
    attempt: number,
    limit: number,
    language: string,
): string {
    const portuguese = language.toLowerCase().startsWith("pt");
    if (state === "running") {
        return portuguese
            ? `Tentativa automática ${attempt}/${limit} em andamento.`
            : `Automatic retry ${attempt}/${limit} is running.`;
    }
    if (state === "recovered") {
        return portuguese
            ? `Conexão recuperada na tentativa ${attempt}/${limit}.`
            : `Connection recovered on attempt ${attempt}/${limit}.`;
    }
    if (state === "cancelled") {
        return portuguese
            ? `Tentativa automática ${attempt}/${limit} cancelada.`
            : `Automatic retry ${attempt}/${limit} was cancelled.`;
    }
    return portuguese
        ? `As ${limit} tentativas automáticas falharam.`
        : `All ${limit} automatic retries failed.`;
}
