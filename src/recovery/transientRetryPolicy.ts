import type { ConfigurationPort } from "../application/ports";

export const DEFAULT_TRANSIENT_RETRY_LIMIT = 3;
export const DEFAULT_RETRY_INITIAL_DELAY_MILLISECONDS = 1_000;
export const MAXIMUM_RETRY_DELAY_MILLISECONDS = 30_000;

export interface RetryPolicy {
    limit: number;
    initialDelayMilliseconds: number;
    afterToolActivity: boolean;
}

export function readRetryPolicy(configuration: ConfigurationPort): RetryPolicy {
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
        limit: configuredNumber(configuredLimit, [0, 2, 3, 5], DEFAULT_TRANSIENT_RETRY_LIMIT),
        initialDelayMilliseconds: configuredNumber(
            configuredDelay,
            [1_000, 2_000, 5_000],
            DEFAULT_RETRY_INITIAL_DELAY_MILLISECONDS,
        ),
        afterToolActivity: configuredBoolean(afterToolActivity, true),
    };
}

export function normalizeAttempt(value: number | undefined): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function configuredNumber(value: unknown, allowed: readonly number[], fallback: number): number {
    const normalized =
        typeof value === "number"
            ? value
            : typeof value === "string" && value.trim().length > 0
              ? Number(value)
              : Number.NaN;
    return Number.isFinite(normalized) && allowed.includes(normalized) ? normalized : fallback;
}

function configuredBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1") return true;
        if (normalized === "false" || normalized === "0") return false;
    }
    return fallback;
}
