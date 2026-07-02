import { setCached } from "../modelCache";
import { getOpenAITokenProvider } from "./token";
import { OpenAIAdapterConfig } from "./types";

// Discovered model ids and id→friendly-name per base URL (GET /models cache).
const discoveredModels = new Map<string, string[]>();
const discoveredLabels = new Map<string, Record<string, string>>();
// Discovered per-model context window (tokens), when the gateway's /models
// catalog reports one — drives the context monitor's "used / total" ratio.
const discoveredContext = new Map<string, Record<string, number>>();

export function getDiscoveredModels(baseUrl: string): string[] | undefined {
    return discoveredModels.get(baseUrl);
}
export function getDiscoveredLabels(baseUrl: string): Record<string, string> | undefined {
    return discoveredLabels.get(baseUrl);
}
export function getDiscoveredContext(baseUrl: string): Record<string, number> | undefined {
    return discoveredContext.get(baseUrl);
}
export function hasDiscoveredModels(baseUrl: string): boolean {
    return discoveredModels.has(baseUrl);
}

/** Store a discovery result for a base URL (in-memory cache shared by both classes). */
export function setDiscovered(
    baseUrl: string,
    models: string[],
    labels: Record<string, string>,
    context?: Record<string, number>,
): void {
    discoveredModels.set(baseUrl, models);
    discoveredLabels.set(baseUrl, labels);
    if (context) { discoveredContext.set(baseUrl, context); }
}

/**
 * GET <baseUrl>/models → populate the in-memory discovery cache and the file
 * cache (shared by OpenAIAdapter and OpenAISession). Auth: explicit headers >
 * apiKey > `loginToken` > the Sufficit login-token provider.
 */
export async function discoverModels(cfg: OpenAIAdapterConfig, backend: string, loginToken?: string | null): Promise<void> {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/models";
    const headers: Record<string, string> = { ...cfg.headers };
    if (cfg.clientInfo) {
        headers["x-client-id"] = cfg.clientInfo.id;
        headers["x-client-version"] = cfg.clientInfo.version;
        headers["x-client-hostname"] = cfg.clientInfo.hostname;
        headers["x-client-os"] = cfg.clientInfo.os;
        headers["user-agent"] = `${cfg.clientInfo.id}/${cfg.clientInfo.version} (${cfg.clientInfo.os}; ${cfg.clientInfo.hostname})`;
    }
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    if (!hasAuth && cfg.apiKey) {
        headers["authorization"] = `Bearer ${cfg.apiKey}`;
    } else if (!hasAuth && loginToken) {
        headers["authorization"] = `Bearer ${loginToken}`;
    } else if (!hasAuth) {
        const provider = getOpenAITokenProvider();
        if (provider) {
            const t = await provider().catch(() => null);
            if (t) { headers["authorization"] = `Bearer ${t}`; }
        }
    }
    const res = await fetch(url, { headers });
    if (!res.ok) { return; }
    const json = await res.json() as { data?: unknown[]; models?: unknown[] };
    const raw = json?.data ?? json?.models ?? [];
    const list: string[] = [];
    const labels: Record<string, string> = {};
    const context: Record<string, number> = {};
    for (const m of raw) {
        let id: string;
        if (typeof m === "string") {
            id = m;
        } else if (typeof m === "object" && m !== null) {
            const obj = m as Record<string, unknown>;
            id = typeof obj.id === "string" ? obj.id : (typeof obj.name === "string" ? obj.name : "");
        } else {
            continue;
        }
        if (!id) { continue; }
        list.push(id);
        const name = typeof m === "object" ? (typeof (m as Record<string, unknown>).name === "string" ? (m as Record<string, unknown>).name : typeof (m as Record<string, unknown>).title === "string" ? (m as Record<string, unknown>).title : undefined) : undefined;
        if (typeof name === "string" && name && name !== id) { labels[id] = name; }
        const ctx = modelContextLength(m);
        if (ctx) { context[id] = ctx; }
    }
    if (list.length) {
        setDiscovered(cfg.baseUrl, list, labels, context);
        setCached(`openai:${cfg.baseUrl}`, { models: list, labels, context, lastUpdate: new Date().toISOString() });
    }
    cfg.log?.(`[${backend}] discovered ${list.length} models from ${url}`);
}

/** Context window (tokens) a /models entry advertises, across common shapes. */
export function modelContextLength(m: unknown): number | undefined {
    if (!m || typeof m !== "object") { return undefined; }
    const o = m as Record<string, unknown>;
    const context = typeof o.context === "object" && o.context !== null ? o.context as Record<string, unknown> : {};
    const limits = typeof o.limits === "object" && o.limits !== null ? o.limits as Record<string, unknown> : {};
    const n = Number(
        o.context_length ?? o.context_window ?? o.max_context_window_tokens ??
        o.max_context_length ?? o.max_input_tokens ?? context.total ??
        limits.context_window ?? limits.max_context_window_tokens ?? 0,
    );
    return Number.isFinite(n) && n > 0 ? n : undefined;
}
