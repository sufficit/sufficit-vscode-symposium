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
