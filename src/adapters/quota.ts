import type { AdapterQuotaSnapshot, UsageQuotaWindow } from "./types";

/** Latest reset among currently blocked windows. A request is only useful
 * again once every blocked window that carries a deadline has reset. */
export function blockedQuotaRetryAt(
    snapshot: AdapterQuotaSnapshot | undefined,
): number | undefined {
    const resets = (snapshot?.windows ?? [])
        .filter((window) => window.status === "blocked")
        .map((window) => window.resetsAt)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return resets.length ? Math.max(...resets) : undefined;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}

function firstString(object: JsonObject | undefined, ...keys: string[]): string | undefined {
    if (!object) {
        return undefined;
    }
    for (const key of keys) {
        if (typeof object[key] === "string" && String(object[key]).trim()) {
            return String(object[key]);
        }
    }
    return undefined;
}

function finiteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

function resetTime(value: unknown): number | undefined {
    const numeric = finiteNumber(value);
    if (numeric != null) {
        // Provider JSON commonly uses Unix seconds; preserve millisecond epochs.
        return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function percentage(object: JsonObject, utilizationIsFraction: boolean): number | undefined {
    const explicit = finiteNumber(
        object.used_percent ??
            object.usedPercent ??
            object.used_percentage ??
            object.usedPercentage ??
            object.percentage ??
            object.percent,
    );
    let value = explicit;
    if (value == null) {
        value = finiteNumber(object.utilization);
        if (value != null && utilizationIsFraction && value >= 0 && value <= 1) {
            value *= 100;
        }
    }
    return value == null ? undefined : Math.max(0, Math.min(100, value));
}

function windowDuration(object: JsonObject): number | undefined {
    const minutes = finiteNumber(
        object.window_minutes ??
            object.windowMinutes ??
            object.window_duration_mins ??
            object.windowDurationMins,
    );
    if (minutes != null && minutes > 0) {
        return minutes;
    }
    const seconds = finiteNumber(object.window_seconds ?? object.windowSeconds);
    return seconds != null && seconds > 0 ? seconds / 60 : undefined;
}

function quotaWindow(
    id: string,
    value: JsonObject,
    utilizationIsFraction: boolean,
): UsageQuotaWindow | undefined {
    const usedPercent = percentage(value, utilizationIsFraction);
    if (usedPercent == null) {
        return undefined;
    }
    const label = firstString(value, "display_name", "displayName", "label", "name");
    const resetsAt = resetTime(
        value.resets_at ?? value.resetsAt ?? value.reset_at ?? value.resetAt,
    );
    const status = firstString(value, "status", "state");
    const windowMinutes = windowDuration(value);
    return {
        id,
        ...(label ? { label } : {}),
        usedPercent,
        ...(windowMinutes != null ? { windowMinutes } : {}),
        ...(resetsAt != null ? { resetsAt } : {}),
        ...(status ? { status } : {}),
    };
}

function collectWindows(
    value: unknown,
    path: string[],
    windows: Map<string, UsageQuotaWindow>,
    utilizationIsFraction: boolean,
    depth = 0,
): void {
    if (depth > 4) {
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            const object = asObject(entry);
            const key =
                firstString(
                    object,
                    "id",
                    "limit_id",
                    "limitId",
                    "display_name",
                    "displayName",
                    "name",
                ) ?? String(index);
            collectWindows(entry, [...path, key], windows, utilizationIsFraction, depth + 1);
        });
        return;
    }
    const object = asObject(value);
    if (!object) {
        return;
    }
    const id =
        path.filter(Boolean).join(":") ||
        firstString(object, "rateLimitType", "rate_limit_type", "limit_id", "limitId") ||
        "usage";
    const normalized = quotaWindow(id, object, utilizationIsFraction);
    if (normalized) {
        windows.set(id, normalized);
        return;
    }
    for (const [key, child] of Object.entries(object)) {
        if (child && typeof child === "object") {
            collectWindows(child, [...path, key], windows, utilizationIsFraction, depth + 1);
        }
    }
}

/**
 * Normalize quota JSON emitted by Codex and Claude without coupling the UI to
 * named windows. Supported shapes include Codex rate_limits, Claude's
 * aggregate rate_limits status object, and one-window rate_limit_event data.
 */
export function parseAdapterQuota(
    event: unknown,
    backend: string,
): AdapterQuotaSnapshot | undefined {
    const root = asObject(event);
    if (!root) {
        return undefined;
    }
    const payload = asObject(root.payload);
    const message = asObject(root.message);

    const aggregate =
        root.rate_limits ??
        root.rateLimits ??
        payload?.rate_limits ??
        payload?.rateLimits ??
        message?.rate_limits ??
        message?.rateLimits;
    const single =
        root.rate_limit_info ??
        root.rateLimitInfo ??
        payload?.rate_limit_info ??
        payload?.rateLimitInfo ??
        message?.rate_limit_info ??
        message?.rateLimitInfo;
    if (!aggregate && !single) {
        return undefined;
    }

    const windows = new Map<string, UsageQuotaWindow>();
    if (aggregate) {
        // Aggregate /usage/statusline objects document utilization as 0..100.
        collectWindows(aggregate, [], windows, false);
    }
    const singleObject = asObject(single);
    if (singleObject) {
        const id =
            firstString(
                singleObject,
                "rateLimitType",
                "rate_limit_type",
                "limitId",
                "limit_id",
                "type",
            ) ?? "usage";
        // Streaming header-derived events commonly express utilization as 0..1.
        const normalized = quotaWindow(id, singleObject, true);
        if (normalized) {
            windows.set(id, normalized);
        }
        const overage = finiteNumber(
            singleObject.overageUtilization ?? singleObject.overage_utilization,
        );
        if (overage != null) {
            const overageWindow = quotaWindow(
                "overage",
                {
                    utilization: overage,
                    resetsAt: singleObject.overageResetsAt ?? singleObject.overage_resets_at,
                    status: singleObject.overageStatus ?? singleObject.overage_status,
                },
                true,
            );
            if (overageWindow) {
                windows.set(overageWindow.id, overageWindow);
            }
        }
    }
    if (windows.size === 0) {
        return undefined;
    }

    const aggregateObject = asObject(aggregate);
    const plan =
        firstString(root, "subscription_type", "subscriptionType", "plan_type", "planType") ??
        firstString(aggregateObject, "plan_type", "planType");
    const limitName =
        firstString(aggregateObject, "limit_name", "limitName") ??
        firstString(root, "limit_name", "limitName");
    const reportedAt = resetTime(
        root.timestamp ??
            root.created_at ??
            root.createdAt ??
            payload?.timestamp ??
            payload?.created_at ??
            payload?.createdAt,
    );
    return {
        backend,
        ...(plan ? { plan } : {}),
        ...(limitName ? { limitName } : {}),
        windows: [...windows.values()],
        updatedAt: reportedAt ?? Date.now(),
    };
}
