import type { AgentEvent } from "../adapters/types";
import type { PendingMessage } from "../application/controllerQueue";
import type { ClockPort, ConfigurationPort } from "../application/ports";
import type { Turn } from "../application/turn";

export const DEFAULT_TRANSIENT_RETRY_LIMIT = 3;
export const DEFAULT_RETRY_INITIAL_DELAY_MILLISECONDS = 1_000;
export const MAXIMUM_RETRY_DELAY_MILLISECONDS = 30_000;

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
    unsafeOutputStarted: boolean;
    toolActivityStarted: boolean;
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
 * and never replay a turn after user-visible output or tool activity started.
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
            unsafeOutputStarted: false,
            toolActivityStarted: false,
        };
    }

    /** Returns false when the raw event must be deferred while recovery runs. */
    observe(event: AgentEvent): boolean {
        const active = this.active;
        if (!active || active.turn.phase === "ended") return true;

        if (startsUnsafeOutput(event)) {
            active.unsafeOutputStarted = true;
            this.flushDeferred(active);
        }
        if (startsToolActivity(event)) active.toolActivityStarted = true;

        if (
            event.kind !== "error" ||
            event.fatal === false ||
            event.retryable !== true ||
            event.automaticRetry === false
        ) {
            return true;
        }

        const policy = readPolicy(this.deps.configuration);
        if (
            active.unsafeOutputStarted ||
            (active.toolActivityStarted && !policy.afterToolActivity)
        ) {
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

        if (turn.outcome === "completed" && active.attempt > 0) {
            this.emitRecovery(
                active.message.automaticRetryId ?? retryIdentity(active),
                "recovered",
                active.attempt,
                readPolicy(this.deps.configuration).limit,
            );
            return false;
        }

        if (active.exhausted) {
            this.emitRecovery(
                active.message.automaticRetryId ?? retryIdentity(active),
                "exhausted",
                active.attempt,
                readPolicy(this.deps.configuration).limit,
                conciseRetryReason(active.exhausted.message),
            );
            return false;
        }

        const deferred = active.deferred;
        if (!deferred || active.unsafeOutputStarted || turn.outcome !== "failed") {
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

    private flushDeferred(active: ActiveAttempt): void {
        if (!active.deferred) return;
        this.deps.emit({ type: "event", event: active.deferred.event });
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

function readPolicy(configuration: ConfigurationPort): {
    limit: number;
    initialDelayMilliseconds: number;
    afterToolActivity: boolean;
} {
    const configuredLimit = configuration.get(
        "symposium",
        "transientRetryLimit",
        DEFAULT_TRANSIENT_RETRY_LIMIT,
    );
    const configuredDelay = configuration.get(
        "symposium",
        "retryInitialDelayMilliseconds",
        DEFAULT_RETRY_INITIAL_DELAY_MILLISECONDS,
    );
    const afterToolActivity = configuration.get(
        "symposium",
        "transientRetryAfterToolActivity",
        true,
    );
    return {
        limit: [0, 2, 3, 5].includes(configuredLimit)
            ? configuredLimit
            : DEFAULT_TRANSIENT_RETRY_LIMIT,
        initialDelayMilliseconds: [1_000, 2_000, 5_000].includes(configuredDelay)
            ? configuredDelay
            : DEFAULT_RETRY_INITIAL_DELAY_MILLISECONDS,
        afterToolActivity: afterToolActivity === true,
    };
}

function normalizeAttempt(value: number | undefined): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function startsUnsafeOutput(event: AgentEvent): boolean {
    if (event.kind === "text") return event.text.trim().length > 0;
    return (
        event.kind === "thinking" ||
        event.kind === "approval-request" ||
        event.kind === "approval-resolved"
    );
}

function startsToolActivity(event: AgentEvent): boolean {
    return event.kind === "tool-start" || event.kind === "tool-output" || event.kind === "tool-end";
}

function retryIdentity(active: ActiveAttempt): string {
    return (
        active.message.intentId ?? active.turn.intentId ?? active.turn.backendId ?? active.turn.id
    );
}

function cloneMessage(message: PendingMessage): PendingMessage {
    return { ...message, attachments: [...message.attachments] };
}

export function conciseRetryReason(message: string): string {
    const status = /\bHTTP\s+\d{3}(?:\s+[A-Za-z][^<\n\r]{0,100})?/i.exec(message)?.[0]?.trim();
    if (status) return status;
    const firstLine = message
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!firstLine) return "temporary provider failure";
    return firstLine.length > 240 ? `${firstLine.slice(0, 237)}…` : firstLine;
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
