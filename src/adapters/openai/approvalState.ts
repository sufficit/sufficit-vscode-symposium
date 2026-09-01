import type { AgentEvent, SessionStartOptions } from "../types";
import { needsApproval, type ToolTier } from "../aiTools/permissionTiers";

type ApprovalTier = Extract<ToolTier, "write" | "destructive">;

/** Owns the live OpenAI-compatible permission mode and pending inline gates. */
export class ApprovalState {
    private readonly pending = new Map<
        string,
        { resolve: (approved: boolean) => void; tier: ApprovalTier }
    >();

    constructor(
        private readonly options: SessionStartOptions,
        private readonly emit: (event: AgentEvent) => void,
    ) {}

    get mode(): string | undefined {
        return this.options.permission;
    }

    request(
        toolId: string,
        toolName: string,
        detail: string | undefined,
        tier: ApprovalTier,
    ): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.pending.set(toolId, { resolve, tier });
            this.emit({ kind: "approval-request", toolId, toolName, detail, tier });
        });
    }

    setMode(permission: string): void {
        this.options.permission = permission;
        if (permission === "plan") return;
        for (const [toolId, pending] of [...this.pending]) {
            if (needsApproval(permission, pending.tier)) continue;
            this.finish(toolId, pending, true);
        }
    }

    resolve(toolId: string, approved: boolean): void {
        const pending = this.pending.get(toolId);
        if (pending) this.finish(toolId, pending, approved);
    }

    private finish(
        toolId: string,
        pending: { resolve: (approved: boolean) => void },
        approved: boolean,
    ): void {
        this.pending.delete(toolId);
        pending.resolve(approved);
        this.emit({ kind: "approval-resolved", toolId, approved });
    }
}
