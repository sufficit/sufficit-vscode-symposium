import { OpenAIAdapterConfig } from "./types";
import { modelContextLength, setDiscovered } from "./models";
import { buildHeaders } from "./httpAuth";

/**
 * Best-effort model discovery from <baseUrl>/models, populating the shared
 * cache so `model()` can resolve a default. Used by run() when no model is
 * selected, so the very first turn after a reload still finds a model.
 * Skipped when models are pinned in settings (the configured list wins).
 *
 * Extracted from OpenAISession.discoverModels(). Headers are built by the
 * shared buildHeaders() helper (dedupes the inline auth logic the original
 * reimplemented).
 */
export async function discoverModels(
    cfg: OpenAIAdapterConfig,
    backend: string,
    loginToken?: string | null,
): Promise<void> {
    if (cfg.models.length || !cfg.baseUrl) { return; }
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/models";
    const headers = buildHeaders(cfg, loginToken);
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
        cfg.log?.(`[${backend}] discovered ${list.length} models from ${url}`);
    }
}
