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
