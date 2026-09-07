import type { ResponsePart } from "@microsoft/agent-host-protocol";
import { resolveRunningTransientRetryNotices } from "./retryStatusNotice";

/** Reconciles ephemeral retry state from authoritative AHP lifecycle actions. */
export function reconcileAhpRetryLifecycle(action: Record<string, unknown>): void {
    if (action.type === "chat/turnComplete") {
        resolveRunningTransientRetryNotices();
        return;
    }
    if (action.type === "chat/turnCancelled") {
        resolveRunningTransientRetryNotices("cancelled");
        return;
    }
    if (action.type !== "chat/responsePart") return;
    const part = action.part as ResponsePart | undefined;
    if (part && isRetryProgressPart(part)) resolveRunningTransientRetryNotices();
}

export function isEmptyStreamAnchor(part: ResponsePart): boolean {
    const value = part as unknown as Record<string, unknown>;
    return (
        (value.kind === "markdown" || value.kind === "reasoning") &&
        String(value.content ?? "") === ""
    );
}

export function isSyntheticControlMessage(message: Record<string, unknown>): boolean {
    const metadata = message._meta;
    return !!metadata && typeof metadata === "object" && "synthetic" in metadata
        ? metadata.synthetic === true
        : false;
}

function isRetryProgressPart(part: ResponsePart): boolean {
    const value = part as unknown as Record<string, unknown>;
    if (value.kind === "markdown" || value.kind === "reasoning") {
        return String(value.content ?? "").trim().length > 0;
    }
    return value.kind === "toolCall";
}
