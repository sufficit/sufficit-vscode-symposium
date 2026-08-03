import type { AdapterQuotaSnapshot, UsageQuotaWindow } from "../adapters/types";

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
        for (const window of previous?.windows ?? []) { windows.set(window.id, window); }
    }
    for (const window of incoming.windows) { windows.set(window.id, window); }
    return {
        ...(authoritative ? {} : previous),
        ...incoming,
        windows: [...windows.values()],
        updatedAt: incoming.updatedAt || Date.now(),
    };
}
