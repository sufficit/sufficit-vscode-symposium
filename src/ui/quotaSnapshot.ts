import type { AdapterQuotaSnapshot, UsageQuotaWindow } from "../adapters/types";

/**
 * Quota/usage events redraw the status bar without carrying session metadata.
 * Preserve the active backend unless the host explicitly sends a new backend
 * field; otherwise an empty redraw would make every quota lookup use key "".
 */
export function resolveStatusbarData(
    previous: Record<string, unknown>,
    incoming?: Record<string, unknown>,
): Record<string, unknown> {
    return incoming && Object.prototype.hasOwnProperty.call(incoming, "backend")
        ? incoming
        : previous;
}

/**
 * Apply a quota event to browser state. Provider reads carry a state and are
 * complete snapshots, so omitted optional fields intentionally clear stale
 * errors/labels. Turn events omit state and may update only one window.
 */
export function mergeQuotaSnapshot(
    previous: AdapterQuotaSnapshot | undefined,
    incoming: AdapterQuotaSnapshot,
): AdapterQuotaSnapshot {
    const authoritative = incoming.state != null;
    const windows = new Map<string, UsageQuotaWindow>();
    if (!authoritative) {
        for (const window of previous?.windows ?? []) {
            windows.set(window.id, window);
        }
    }
    for (const window of incoming.windows) {
        windows.set(window.id, window);
    }
    return {
        ...(authoritative ? {} : previous),
        ...incoming,
        windows: [...windows.values()],
        updatedAt: incoming.updatedAt || Date.now(),
    };
}
