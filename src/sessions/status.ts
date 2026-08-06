import type { SessionStatus, SessionTerminalStatus } from "../adapters/sessionInfo";

/** Maps controller state to the status exposed to the sessions list. */
export function liveSessionStatus(isBusy: boolean, attentionStatus?: SessionTerminalStatus): SessionStatus {
    if (isBusy) { return "working"; }
    return attentionStatus ?? "idle";
}

export type FollowSessionStatus = "working" | "idle";

/**
 * Last-known status for a session mirrored from a process outside a local
 * ChatController. It is deliberately independent of a particular webview so
 * switching sections does not erase the process state from the sessions list.
 */
export class FollowStatusRegistry {
    private readonly values = new Map<string, FollowSessionStatus>();

    get(sessionId: string): FollowSessionStatus | undefined { return this.values.get(sessionId); }

    set(sessionId: string, status: FollowSessionStatus): void { this.values.set(sessionId, status); }

    delete(sessionId: string): boolean { return this.values.delete(sessionId); }

    clear(): void { this.values.clear(); }
}
