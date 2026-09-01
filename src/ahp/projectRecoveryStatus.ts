import type { AgentEvent } from "../adapters/types";
import type { AhpProjectionAction } from "./projectionCore";

/** Projects recovery as ephemeral UI state, never as conversation history. */
export function projectRecoveryStatus(
    event: Extract<AgentEvent, { kind: "status-notice" }> & {
        recovery: NonNullable<Extract<AgentEvent, { kind: "status-notice" }>["recovery"]>;
    },
): AhpProjectionAction[] {
    return [
        {
            channel: "chat",
            action: {
                type: "symposium/recoveryStatus",
                content: event.text,
                severity: event.severity ?? "info",
                recovery: event.recovery,
            },
        },
    ];
}
