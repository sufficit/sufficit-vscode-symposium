/** Actions available when a user submits while the current turn is running. */
export type BusySendMode = "redirect" | "queue" | "steer";

/** Waiting is the safe default; interruption must always be an explicit choice. */
export const DEFAULT_BUSY_SEND_MODE: BusySendMode = "queue";

/** Normalizes persisted/configured values without silently choosing interruption. */
export function normalizeBusySendMode(value: unknown): BusySendMode {
    return value === "redirect" || value === "queue" || value === "steer"
        ? value
        : DEFAULT_BUSY_SEND_MODE;
}
