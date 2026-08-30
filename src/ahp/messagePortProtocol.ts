import type { ActionEnvelope, Snapshot } from "@microsoft/agent-host-protocol";

export type AhpPortConnectionStatus = "connecting" | "reconciling" | "caught-up" | "failed";

export type AhpMessagePortFrame =
    | { kind: "reset"; generation: number }
    | { kind: "snapshot"; generation: number; snapshot: Snapshot }
    | { kind: "action"; generation: number; envelope: ActionEnvelope }
    | {
          kind: "status";
          generation: number;
          status: AhpPortConnectionStatus;
          detail?: string;
      };

export interface AhpMessagePortEnvelope {
    type: "ahp-frame";
    frame: AhpMessagePortFrame;
}
