import type { AgentBackend } from "./sessionInfo";

/** One rolling account-usage window reported by an adapter CLI. */
export interface UsageQuotaWindow {
    id: string;
    label?: string;
    usedPercent: number;
    remainingPercent?: number;
    windowMinutes?: number;
    resetsAt?: number;
    status?: string;
    detail?: string;
}

export interface AdapterQuotaSnapshot {
    backend: AgentBackend;
    displayName?: string;
    healthPercent?: number;
    plan?: string;
    limitName?: string;
    windows: UsageQuotaWindow[];
    updatedAt: number;
    state?: "ready" | "stale" | "unavailable";
    message?: string;
}

export interface AdapterUsageProvider {
    readonly backend: AgentBackend;
    readonly displayName: string;
    read(force?: boolean, context?: { model?: string }): Promise<AdapterQuotaSnapshot>;
}
