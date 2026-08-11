/** Actions available when a user submits while the current turn is running. */
export type BusySendMode = "redirect" | "queue" | "steer";
export type AhpSubmissionKind = "redirect" | "send" | "steering";

/** Waiting is the safe default; interruption must always be an explicit choice. */
export const DEFAULT_BUSY_SEND_MODE: BusySendMode = "queue";

/** Normalizes persisted/configured values without silently choosing interruption. */
export function normalizeBusySendMode(value: unknown): BusySendMode {
    return value === "redirect" || value === "queue" || value === "steer"
        ? value
        : DEFAULT_BUSY_SEND_MODE;
}

/** A queue preference is conditional on the host actually being busy. The
 * client action itself is therefore a send; the host queue projection is the
 * sole authority that can later turn it into a visible pending row. */
export function ahpSubmissionKind(value: unknown): AhpSubmissionKind {
    if (value === "steer" || value === "steering") return "steering";
    return value === "redirect" ? "redirect" : "send";
}
