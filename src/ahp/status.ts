/**
 * Session status wire layout: the low 5 bits (mask 31) hold the mutually
 * exclusive activity state, bit 5 (32) is `isRead` and bit 6 (64) is
 * `isArchived`; higher bits are unused today. Example: 40 = 8 | 32 = a turn
 * running (`inProgress`) in an already-read session.
 */
export type SessionStatusName = "working" | "idle" | "error" | "inputNeeded";

export interface DecodedSessionStatus {
    /** Named activity state; `working` covers inProgress (8) and inputNeeded (24). */
    name: SessionStatusName;
    read: boolean;
    archived: boolean;
}

export const AHP_STATUS = {
    idle: 1,
    error: 2,
    inProgress: 8,
    inputNeeded: 24,
    isRead: 32,
    isArchived: 64,
} as const;

export function statusWithFlags(base: number, isRead: boolean, archived: boolean): number {
    return base | (isRead ? AHP_STATUS.isRead : 0) | (archived ? AHP_STATUS.isArchived : 0);
}

export function replaceActivityStatus(current: number, activity: number): number {
    const activityMask = (1 << 5) - 1;
    return (current & ~activityMask) | activity;
}

export function isArchivedStatus(status: number): boolean {
    return (status & AHP_STATUS.isArchived) !== 0;
}

/**
 * Decode a numeric session/chat status into a stable named activity state plus
 * the separate read/archived flags, so clients never have to guess what a bare
 * number like 33, 34, 40 or 96 means (issue #56).
 */
export function decodeSessionStatus(status: number): DecodedSessionStatus {
    const base = status & 31;
    return {
        name:
            base === AHP_STATUS.inProgress || base === AHP_STATUS.inputNeeded
                ? "working"
                : base === AHP_STATUS.error
                  ? "error"
                  : "idle",
        read: (status & AHP_STATUS.isRead) !== 0,
        archived: (status & AHP_STATUS.isArchived) !== 0,
    };
}

/** Activity state that still needs the user's attention (`inputNeeded`, 24). */
export function isInputNeededStatus(status: number): boolean {
    return (status & 31) === AHP_STATUS.inputNeeded;
}
