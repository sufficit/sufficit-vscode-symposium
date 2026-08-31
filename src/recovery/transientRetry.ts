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

interface ActiveAttempt {
    turn: Turn;
    message: PendingMessage;
    attempt: number;
    visibleOutputStarted: boolean;
    deferred?: DeferredRetryError;
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
            visibleOutputStarted: false,
        };
    }

    /** Returns false when the raw event must be deferred while recovery runs. */
    observe(event: AgentEvent): boolean {
        const active = this.active;
        if (!active || active.turn.phase === "ended") return true;

        if (startsVisibleOutput(event)) {
            active.visibleOutputStarted = true;
            this.flushDeferred(active);
        }

        if (
            event.kind !== "error" ||
            event.fatal === false ||
            event.retryable !== true ||
            active.visibleOutputStarted
        ) {
            return true;
        }

        const policy = readPolicy(this.deps.configuration);
        if (active.attempt >= policy.limit) return true;

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

        const deferred = active.deferred;
        if (!deferred || active.visibleOutputStarted || turn.outcome !== "failed") {
            this.flushDeferred(active);
            return false;
        }

        const attempt = active.attempt + 1;
        const delayMilliseconds = Math.min(
            deferred.initialDelayMilliseconds * 2 ** active.attempt,
            MAXIMUM_RETRY_DELAY_MILLISECONDS,
        );
        const reason = conciseRetryReason(deferred.event.message);
        const retry: PendingMessage = {
            ...cloneMessage(active.message),
            id: undefined,
            clientMessageId: undefined,
            retryOf: turn.backendId ?? turn.id,
            interruptedBy: reason,
            automaticRetryAttempt: attempt,
        };

        this._pending = true;
        this.deps.log?.(
            `[retry] transient failure; retry ${attempt}/${deferred.limit} in ${delayMilliseconds} ms: ${reason}`,
        );
        this.deps.emit({
            type: "event",
            event: {
                kind: "status-notice",
                severity: "warning",
                text: retryScheduledText(
                    delayMilliseconds,
                    attempt,
                    deferred.limit,
                    this.deps.configuration.language,
                ),
            },
        });
        this.deps.statusChanged();
        this.timer = this.deps.clock.setTimeout(() => {
            this.timer = undefined;
            this._pending = false;
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
        const changed = this._pending;
        this._pending = false;
        this.active = undefined;
        if (changed) {
            this.deps.log?.("[retry] scheduled automatic retry cancelled by a newer action");
            this.deps.statusChanged();
        }
        return changed;
    }

    private flushDeferred(active: ActiveAttempt): void {
        if (!active.deferred) return;
        this.deps.emit({ type: "event", event: active.deferred.event });
        active.deferred = undefined;
    }
}

function readPolicy(configuration: ConfigurationPort): {
    limit: number;
    initialDelayMilliseconds: number;
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
    return {
        limit: [0, 2, 3, 5].includes(configuredLimit)
            ? configuredLimit
            : DEFAULT_TRANSIENT_RETRY_LIMIT,
        initialDelayMilliseconds: [1_000, 2_000, 5_000].includes(configuredDelay)
            ? configuredDelay
            : DEFAULT_RETRY_INITIAL_DELAY_MILLISECONDS,
    };
}

function normalizeAttempt(value: number | undefined): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function startsVisibleOutput(event: AgentEvent): boolean {
    if (event.kind === "text") return event.text.trim().length > 0;
    return (
        event.kind === "thinking" ||
        event.kind === "tool-start" ||
        event.kind === "tool-output" ||
        event.kind === "tool-end" ||
        event.kind === "approval-request" ||
        event.kind === "approval-resolved"
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
