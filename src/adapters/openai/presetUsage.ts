import type { AdapterQuotaSnapshot, AdapterUsageProvider } from "../types";
import { discoverModels } from "./discovery";
import { buildHeaders, resolveAuthToken } from "./httpAuth";
import { getDiscoveredLabels, getDiscoveredModels } from "./models";
import type { OpenAIAdapterConfig } from "./types";

type JsonObject = Record<string, unknown>;

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const SUFFICIT_OPENAI_PATH = "/openai/v1";

function asObject(value: unknown): JsonObject | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}

function property(object: JsonObject | undefined, ...names: string[]): unknown {
    if (!object) {
        return undefined;
    }
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(object, name)) {
            return object[name];
        }
    }
    return undefined;
}

function textValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value));
}

export function normalizePresetId(value: string | undefined): string | undefined {
    const compact = value?.trim().replace(/-/g, "").toLowerCase();
    if (!compact || !/^[0-9a-f]{32}$/.test(compact)) {
        return undefined;
    }
    return [
        compact.slice(0, 8),
        compact.slice(8, 12),
        compact.slice(12, 16),
        compact.slice(16, 20),
        compact.slice(20),
    ].join("-");
}

export function sufficitPresetUsageUrl(baseUrl: string, presetId: string): string | undefined {
    try {
        const base = new URL(baseUrl);
        if (base.pathname.replace(/\/+$/, "") !== SUFFICIT_OPENAI_PATH) {
            return undefined;
        }
        const endpoint = new URL("/api/ai/presets/usage-summary", base.origin);
        endpoint.searchParams.set("presetId", presetId);
        return endpoint.toString();
    } catch {
        return undefined;
    }
}

export function parseSufficitPresetUsage(
    value: unknown,
    backend: string,
    adapterName: string,
): AdapterQuotaSnapshot | undefined {
    const root = asObject(value);
    if (!root) {
        return undefined;
    }
    const presetId = textValue(property(root, "presetId", "preset_id", "PresetId"));
    if (!presetId) {
        return undefined;
    }
    const presetTitle = textValue(property(root, "presetTitle", "preset_title", "PresetTitle"));
    const rawHealthPercent = finiteNumber(
        property(root, "healthPercent", "health_percent", "HealthPercent"),
    );
    const healthPercent = rawHealthPercent == null ? undefined : clampPercent(rawHealthPercent);
    return {
        backend,
        displayName: presetTitle ? `${adapterName} · ${presetTitle}` : adapterName,
        ...(healthPercent != null ? { healthPercent } : {}),
        windows: [],
        updatedAt: Date.now(),
        state: healthPercent != null ? "ready" : "unavailable",
        ...(healthPercent == null
            ? { message: "The selected preset did not report aggregate health." }
            : {}),
    };
}

function unavailable(backend: string, displayName: string, message: string): AdapterQuotaSnapshot {
    return {
        backend,
        displayName,
        windows: [],
        updatedAt: Date.now(),
        state: "unavailable",
        message,
    };
}

export class SufficitPresetUsage implements AdapterUsageProvider {
    private readonly cached = new Map<string, { readAt: number; value: AdapterQuotaSnapshot }>();

    constructor(
        readonly backend: string,
        readonly displayName: string,
        private readonly getConfig: () => OpenAIAdapterConfig,
    ) {}

    private async presetId(model: string | undefined, force: boolean): Promise<string | undefined> {
        const cfg = this.getConfig();
        const direct = normalizePresetId(model) ?? normalizePresetId(cfg.model);
        if (direct) {
            return direct;
        }

        const resolveLabel = (candidate: string | undefined): string | undefined => {
            if (!candidate) {
                return undefined;
            }
            const labels = getDiscoveredLabels(cfg.baseUrl) ?? {};
            const match = Object.entries(labels).find(
                ([, label]) =>
                    label.localeCompare(candidate, undefined, { sensitivity: "accent" }) === 0,
            );
            return normalizePresetId(match?.[0]);
        };
        const byKnownLabel = resolveLabel(model) ?? resolveLabel(cfg.model);
        if (byKnownLabel) {
            return byKnownLabel;
        }

        let models = getDiscoveredModels(cfg.baseUrl) ?? cfg.models;
        if (force || models.length === 0) {
            const loginToken = await resolveAuthToken(cfg, force);
            await discoverModels(cfg, this.backend, loginToken).catch(() => false);
            models = getDiscoveredModels(cfg.baseUrl) ?? models;
        }
        return (
            resolveLabel(model) ??
            resolveLabel(cfg.model) ??
            models.map(normalizePresetId).find((id): id is string => !!id)
        );
    }

    async read(force = false, context: { model?: string } = {}): Promise<AdapterQuotaSnapshot> {
        const cfg = this.getConfig();
        const presetId = await this.presetId(context.model, force);
        if (!presetId) {
            return unavailable(
                this.backend,
                this.displayName,
                "Select a Sufficit preset to see its provider usage.",
            );
        }
        const endpoint = sufficitPresetUsageUrl(cfg.baseUrl, presetId);
        if (!endpoint) {
            return unavailable(
                this.backend,
                this.displayName,
                "Preset usage is available only through a Sufficit /openai/v1 endpoint.",
            );
        }
        const cached = this.cached.get(presetId);
        if (!force && cached && Date.now() - cached.readAt < CACHE_TTL_MS) {
            return cached.value;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let failureMessage: string | undefined;
        try {
            const loginToken = await resolveAuthToken(cfg, force);
            const response = await fetch(endpoint, {
                method: "GET",
                headers: { ...buildHeaders(cfg, loginToken), accept: "application/json" },
                signal: controller.signal,
            });
            if (!response.ok) {
                failureMessage =
                    response.status === 401
                        ? "Preset usage authentication expired. Sign in to Sufficit again, then refresh."
                        : response.status === 403
                          ? "Your Sufficit account cannot read usage for this preset."
                          : response.status === 404
                            ? "The selected preset is no longer available. Refresh the model list and choose another preset."
                            : response.status === 429
                              ? "Preset usage is temporarily rate limited. Try refreshing in a moment."
                              : `Preset usage refresh failed (HTTP ${response.status}).`;
            } else {
                const parsed = parseSufficitPresetUsage(
                    await response.json(),
                    this.backend,
                    this.displayName,
                );
                if (parsed) {
                    this.cached.set(presetId, { readAt: Date.now(), value: parsed });
                    return parsed;
                }
                failureMessage = "Sufficit returned an unrecognized preset usage response.";
            }
        } catch (error) {
            failureMessage =
                (error as { name?: string })?.name === "AbortError"
                    ? "Preset usage refresh timed out."
                    : "Preset usage refresh failed. Check the connection and try again.";
        } finally {
            clearTimeout(timeout);
        }

        if (cached) {
            const stale = {
                ...cached.value,
                state: "stale" as const,
                message: `${failureMessage} Showing cached values.`,
            };
            this.cached.set(presetId, { readAt: Date.now(), value: stale });
            return stale;
        }
        return unavailable(
            this.backend,
            this.displayName,
            failureMessage ?? "Preset usage is unavailable.",
        );
    }
}
