import type { TransientRetryNotice } from "../../adapters/types";
import { renderStatusNotice } from "./messages";

/** Renders the AHP extension action used for ephemeral recovery state. */
export function renderAhpRecoveryStatus(action: Record<string, unknown>): void {
    const recovery = retryNotice(action.recovery);
    if (!recovery) return;
    renderStatusNotice(
        typeof action.content === "string" ? action.content : "",
        undefined,
        severity(action.severity),
        undefined,
        recovery,
    );
}

function retryNotice(value: unknown): TransientRetryNotice | undefined {
    const record = asRecord(value);
    const state = record.state;
    if (
        typeof record.id !== "string" ||
        !["scheduled", "running", "recovered", "cancelled", "exhausted"].includes(String(state)) ||
        typeof record.attempt !== "number" ||
        typeof record.limit !== "number"
    ) {
        return undefined;
    }
    return {
        id: record.id,
        state: state as TransientRetryNotice["state"],
        attempt: record.attempt,
        limit: record.limit,
        ...(typeof record.retryAt === "number" ? { retryAt: record.retryAt } : {}),
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    };
}

function severity(value: unknown): "info" | "warning" | "error" {
    return value === "warning" || value === "error" ? value : "info";
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
