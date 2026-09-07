import type { AgentEvent } from "../adapters/types";
import {
    activity,
    chatAction,
    partId,
    type AhpProjectionAction,
    type AhpProjectionState,
} from "./projectionCore";
import { projectRecoveryStatus } from "./projectRecoveryStatus";

/** Keeps operational notices transient while preserving terminal explanations. */
export function projectStatusNotice(
    state: AhpProjectionState,
    event: Extract<AgentEvent, { kind: "status-notice" }>,
): AhpProjectionAction[] {
    if (event.recovery) {
        return projectRecoveryStatus({ ...event, recovery: event.recovery });
    }
    if (!event.terminal || !state.turnId) {
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
