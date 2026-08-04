import type { SessionStatus, SessionTerminalStatus } from "../adapters/sessionInfo";

/** Maps controller state to the status exposed to the sessions list. */
export function liveSessionStatus(isBusy: boolean, attentionStatus?: SessionTerminalStatus): SessionStatus {
    if (isBusy) { return "working"; }
    return attentionStatus ?? "idle";
}
