import type { AgentEvent } from "../adapters/types";
import {
    activity,
    chatAction,
    partId,
    type AhpProjectionAction,
    type AhpProjectionState,
} from "./projectionCore";
import { projectRecoveryStatus } from "./projectRecoveryStatus";

/** Keeps routine operations transient while preserving visible and terminal notices. */
export function projectStatusNotice(
    state: AhpProjectionState,
    event: Extract<AgentEvent, { kind: "status-notice" }>,
): AhpProjectionAction[] {
    if (event.recovery) {
        return projectRecoveryStatus({ ...event, recovery: event.recovery });
    }
    if ((!event.terminal && !event.transcript) || !state.turnId) {
        return activity(event.text);
    }
    state.textPartId = undefined;
    return [
        chatAction("chat/responsePart", state.turnId, {
            part: {
                kind: "notice",
                id: partId(state, "notice"),
                content: event.text,
                _meta: { severity: event.severity ?? "info" },
            },
        }),
    ];
}
