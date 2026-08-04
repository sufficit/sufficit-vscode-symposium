import type { SessionStatus } from "../adapters/sessionInfo";

/** Maps controller state to the status exposed to the sessions list. */
export function liveSessionStatus(isBusy: boolean, attentionRequired: boolean): SessionStatus {
    if (isBusy) { return "working"; }
    return attentionRequired ? "error" : "idle";
}
