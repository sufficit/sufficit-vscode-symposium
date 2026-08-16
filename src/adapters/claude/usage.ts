import * as os from "node:os";
import * as path from "node:path";
import { JsonlAdapterUsage } from "../quotaCache";
import { parseAdapterQuota } from "../quota";
import type { AdapterQuotaSnapshot, AdapterUsageProvider, UsageQuotaWindow } from "../types";
import { claudeOAuthMetadata, claudeOAuthToken } from "./credentials";

type JsonObject = Record<string, unknown>;

const LIMIT_MESSAGE =
    /(?:you(?:'|’)ve\s+)?hit your\s+(.+?)\s+limit\s*[·-]\s*resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 60_000;

interface ClaudeUsageFetch {
    snapshot?: AdapterQuotaSnapshot;
    message?: string;
}

export function claudeUsageAuthMessage(reason: "missing-token" | "rejected-token"): string {
    return reason === "missing-token"
        ? "Live Claude account usage is unavailable because no usable Claude Code OAuth token was found. Claude requests may still work through the CLI or an API key; this only affects account-usage display."
        : "Claude's live usage endpoint rejected the OAuth token (HTTP 401). Claude requests may still work through the CLI; this only affects account-usage display. Cached data may be out of date.";
}

function asObject(value: unknown): JsonObject | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}

function eventText(root: JsonObject): string {
    const texts: string[] = [];
    if (typeof root.result === "string") {
        texts.push(root.result);
    }
    const message = asObject(root.message);
    if (typeof message?.content === "string") {
        texts.push(message.content);
    }
    if (Array.isArray(message?.content)) {
        for (const block of message.content) {
            const entry = asObject(block);
            if (entry?.type === "text" && typeof entry.text === "string") {
                texts.push(entry.text);
            }
        }
    }
    return texts.join("\n");
}

function finiteNumber(value: unknown): number | undefined {
    const number =
        typeof value === "number"
            ? value
            : typeof value === "string" && value.trim()
              ? Number(value)
              : NaN;
    return Number.isFinite(number) ? number : undefined;
}

function resetTime(value: unknown): number | undefined {
    if (typeof value !== "string" && typeof value !== "number") {
        return undefined;
    }
    const parsed = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    return typeof value === "number" && value < 10_000_000_000 ? value * 1000 : parsed;
}

function displayName(value: string): string {
    return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Claude uses different names for the same account windows in API snapshots
 * and hard-limit messages. Keep provider-specific aliases out of the generic UI
 * while preserving every unknown/new provider id unchanged.
 */
export function canonicalClaudeWindowId(value: string): string {
    const key = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
    const base = key.replace(/_limit$/, "");
    if (base === "weekly" || base === "week" || base === "seven_day" || base === "7_day") {
        return "seven_day";
    }
    if (base === "session" || base === "five_hour" || base === "5_hour") {
        return "five_hour";
    }
    return value;
}

function apiWindow(id: string, value: JsonObject, label?: string): UsageQuotaWindow | undefined {
    if (value.enabled === false) {
        return undefined;
    }
    const utilization = finiteNumber(value.utilization ?? value.percent);
    if (utilization == null) {
        return undefined;
    }
    const resetsAt = resetTime(value.resets_at ?? value.resetsAt);
    const status =
        typeof value.severity === "string"
            ? value.severity
            : typeof value.status === "string"
              ? value.status
              : undefined;
    return {
        id,
        ...(label ? { label } : {}),
        usedPercent: Math.max(0, Math.min(100, utilization)),
        ...(resetsAt != null ? { resetsAt } : {}),
        ...(status ? { status } : {}),
    };
}

/** Normalize the dynamic JSON returned by Claude Code's own /api/oauth/usage request. */
export function parseClaudeApiUsage(
    value: unknown,
    metadata: { subscriptionType?: string } = {},
): AdapterQuotaSnapshot | undefined {
    const root = asObject(value);
    if (!root) {
        return undefined;
    }
    const windows = new Map<string, UsageQuotaWindow>();

    // Discover every top-level utilization window rather than coupling the UI
    // to today's five-hour/weekly names. New provider windows render unchanged.
    for (const [id, candidate] of Object.entries(root)) {
        const object = asObject(candidate);
        if (!object) {
            continue;
        }
        const canonicalId = canonicalClaudeWindowId(id);
        const window = apiWindow(canonicalId, object);
        if (window) {
            windows.set(canonicalId, window);
        }
    }

    // Newer Claude responses also expose a dynamic limits array. Retain entries
    // that add information (not aliases of a top-level window), including model
    // scoped limits discovered from their scope metadata.
    if (Array.isArray(root.limits)) {
        root.limits.forEach((candidate, index) => {
            const object = asObject(candidate);
            if (!object) {
                return;
            }
            const scope = asObject(object.scope);
            const model = asObject(scope?.model);
            const scopedLabel =
                typeof model?.display_name === "string" ? model.display_name : undefined;
            const kind =
                typeof object.kind === "string"
                    ? object.kind
                    : typeof object.group === "string"
                      ? object.group
                      : `limit_${index + 1}`;
            const canonicalKind = canonicalClaudeWindowId(kind);
            const id = scopedLabel ? `${kind}:${scopedLabel}` : canonicalKind;
            const label =
                scopedLabel ||
                (canonicalKind === kind && typeof object.group === "string"
                    ? displayName(object.group)
                    : undefined);
            const window = apiWindow(id, object, label);
            if (!window) {
                return;
            }
            const sameId = windows.get(id);
            if (sameId && !scopedLabel) {
                windows.set(id, {
                    ...window,
                    ...sameId,
                    ...(window.status ? { status: window.status } : {}),
                });
                return;
            }
            const duplicate =
                !scopedLabel &&
                [...windows.values()].some(
                    (existing) =>
                        existing.usedPercent === window.usedPercent &&
                        existing.resetsAt === window.resetsAt,
                );
            if (!duplicate) {
                windows.set(id, window);
            }
        });
    }
    if (windows.size === 0) {
        return undefined;
    }
    return {
        backend: "claude",
        ...(metadata.subscriptionType ? { plan: displayName(metadata.subscriptionType) } : {}),
        windows: [...windows.values()],
        updatedAt: Date.now(),
    };
}

function nextZonedTime(
    after: number,
    hour12: number,
    minute: number,
    meridiem: string,
    timeZone: string,
): number | undefined {
    let hour = hour12 % 12;
    if (meridiem.toLowerCase() === "pm") {
        hour += 12;
    }
    let formatter: Intl.DateTimeFormat;
    try {
        formatter = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        });
    } catch {
        return undefined;
    }
    const firstMinute = Math.floor(after / 60_000) * 60_000 + 60_000;
    const end = firstMinute + 48 * 60 * 60_000;
    for (let candidate = firstMinute; candidate <= end; candidate += 60_000) {
        const parts = formatter.formatToParts(candidate);
        const candidateHour = Number(parts.find((part) => part.type === "hour")?.value);
        const candidateMinute = Number(parts.find((part) => part.type === "minute")?.value);
        if (candidateHour === hour && candidateMinute === minute) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * Claude Code 2.x persists hard account limits as synthetic API-error
 * messages instead of rate_limit_info. Normalize that provider-owned shape
 * while retaining support for aggregate and streaming quota events.
 */
export function parseClaudeQuota(
    event: unknown,
    backend = "claude",
): AdapterQuotaSnapshot | undefined {
    const standard = parseAdapterQuota(event, backend);
    if (standard) {
        return standard;
    }

    const root = asObject(event);
    if (!root) {
        return undefined;
    }
    const isStructuredLimit =
        root.error === "rate_limit" ||
        root.apiErrorStatus === 429 ||
        (root.type === "result" && root.is_error === true);
    if (!isStructuredLimit) {
        return undefined;
    }
    const match = eventText(root).match(LIMIT_MESSAGE);
    if (!match) {
        return undefined;
    }

    const reportedAt = typeof root.timestamp === "string" ? Date.parse(root.timestamp) : NaN;
    const updatedAt = Number.isFinite(reportedAt) ? reportedAt : Date.now();
    const limit = match[1].trim();
    const rawId = `${
        limit
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "") || "session"
    }_limit`;
    const id = canonicalClaudeWindowId(rawId);
    const resetsAt = nextZonedTime(
        updatedAt,
        Number(match[2]),
        Number(match[3] || 0),
        match[4],
        match[5],
    );
    return {
        backend,
        limitName: "Limit reached",
        windows: [
            {
                id,
                ...(id === rawId
                    ? { label: `${limit.charAt(0).toUpperCase()}${limit.slice(1)} limit` }
                    : {}),
                usedPercent: 100,
                ...(resetsAt != null ? { resetsAt } : {}),
                status: "blocked",
            },
        ],
        updatedAt,
    };
}

const transcriptUsage = new JsonlAdapterUsage(
    "claude",
    "Claude",
    () => [path.join(os.homedir(), ".claude", "projects")],
    parseClaudeQuota,
);

async function fetchClaudeUsage(): Promise<ClaudeUsageFetch> {
    const accessToken = await claudeOAuthToken();
    if (!accessToken) {
        return {
            message: claudeUsageAuthMessage("missing-token"),
        };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
        const response = await fetch(USAGE_ENDPOINT, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "anthropic-beta": "oauth-2025-04-20",
                "user-agent": "sufficit-vscode-symposium/claude-usage",
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            return {
                message:
                    response.status === 401
                        ? claudeUsageAuthMessage("rejected-token")
                        : `Live Claude usage refresh failed (HTTP ${response.status}). Cached data may be out of date.`,
            };
        }
        const snapshot = parseClaudeApiUsage(await response.json(), claudeOAuthMetadata());
        return snapshot
            ? { snapshot }
            : {
                  message:
                      "Claude returned no recognized usage windows. Cached data may be out of date.",
              };
    } catch (error) {
        return {
            message:
                (error as { name?: string })?.name === "AbortError"
                    ? "Live Claude usage refresh timed out. Cached data may be out of date."
                    : "Live Claude usage refresh failed. Cached data may be out of date.",
        };
    } finally {
        clearTimeout(timeout);
    }
}

/** Preserve the best local snapshot without presenting it as a live refresh. */
export function staleClaudeUsage(
    fallback: AdapterQuotaSnapshot,
    displayName: string,
    message: string | undefined,
): AdapterQuotaSnapshot {
    return {
        ...fallback,
        displayName,
        state: "stale",
        message: message ?? "Live Claude usage is unavailable. Cached data may be out of date.",
    };
}

class ClaudeUsage implements AdapterUsageProvider {
    readonly backend = "claude";
    readonly displayName = "Claude";
    private cached: { readAt: number; value: AdapterQuotaSnapshot } | undefined;

    async read(force = false): Promise<AdapterQuotaSnapshot> {
        if (!force && this.cached && Date.now() - this.cached.readAt < CACHE_TTL_MS) {
            return this.cached.value;
        }
        const live = await fetchClaudeUsage();
        let value: AdapterQuotaSnapshot;
        if (live.snapshot) {
            value = { ...live.snapshot, displayName: this.displayName, state: "ready" };
        } else {
            const fallback = this.cached?.value ?? (await transcriptUsage.read(force));
            value = staleClaudeUsage(fallback, this.displayName, live.message);
        }
        this.cached = { readAt: Date.now(), value };
        return value;
    }
}

/** Account-usage singleton for every Claude conversation. */
export const claudeUsage: AdapterUsageProvider = new ClaudeUsage();
