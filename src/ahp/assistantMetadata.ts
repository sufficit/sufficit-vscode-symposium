/** Provider-neutral metadata attached to an AHP assistant response part. */
export interface AssistantMetadata {
    ts?: number;
    model?: string;
    reasoning?: string;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function timestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Wraps assistant metadata in the extension-owned AHP namespace. */
export function assistantMetadata(values: AssistantMetadata): Record<string, unknown> | undefined {
    const symposium = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== undefined && value !== ""),
    );
    return Object.keys(symposium).length ? { symposium } : undefined;
}

/** Reads assistant metadata from an AHP part/action without trusting foreign fields. */
export function readAssistantMetadata(value: unknown): AssistantMetadata {
    const symposium = record(record(value).symposium);
    const ts = timestamp(symposium.ts);
    return {
        ...(ts !== undefined ? { ts } : {}),
        ...(typeof symposium.model === "string" && symposium.model
            ? { model: symposium.model }
            : {}),
        ...(typeof symposium.reasoning === "string" && symposium.reasoning
            ? { reasoning: symposium.reasoning }
            : {}),
    };
}

/** Keeps metadata on a stream anchor when later deltas refine it. */
export function mergeAssistantMetadata(current: unknown, incoming: unknown): unknown {
    const base = record(current);
    const next = record(incoming);
    if (!Object.keys(next).length) return Object.keys(base).length ? base : undefined;
    return {
        ...base,
        ...next,
        symposium: { ...record(base.symposium), ...record(next.symposium) },
    };
}
