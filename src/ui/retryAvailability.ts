export interface RetryAvailability {
    waiting: boolean;
    remainingMilliseconds: number;
}

/** Normalizes a provider-owned retry deadline for both rendering and tests. */
export function retryAvailability(
    retryAt: number | undefined,
    now = Date.now(),
): RetryAvailability {
    const valid = typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > 0;
    const remainingMilliseconds = valid ? Math.max(0, retryAt - now) : 0;
    return { waiting: remainingMilliseconds > 0, remainingMilliseconds };
}

/** Compact, locale-neutral duration used inside translated surrounding copy. */
export function formatRetryRemaining(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}min`;
    if (minutes > 0) return `${minutes}min ${seconds}s`;
    return `${seconds}s`;
}
