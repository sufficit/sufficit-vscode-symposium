import { AgentAdapter } from "../adapters/types";

/** Normalizes a model label for pin matching: lowercase, drop "(...)", collapse spaces. */
export function normModel(s: string): string {
    return s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Resolves an agent-def model pin (a label like "Sufficit AI - Development (ollama)")
 * to a real model id offered by the backend, via its discovered id→name labels.
 * Returns undefined when the backend isn't label-aware or no match is found
 * (caller then leaves the model unset → backend default).
 */
export async function resolveModelPin(adapter: AgentAdapter, pin: string): Promise<string | undefined> {
    if (!pin) { return undefined; }
    if (!adapter.modelLabels) { return undefined; }
    // If the pin is already a known model id, use it directly.
    if (adapter.models && adapter.models().includes(pin)) { return pin; }
    let labels = adapter.modelLabels();
    if ((!labels || Object.keys(labels).length === 0) && adapter.refreshModels) {
        labels = (await adapter.refreshModels().catch(() => undefined))?.labels ?? labels;
    }
    const want = normModel(pin);
    for (const [id, name] of Object.entries(labels ?? {})) {
        if (normModel(name) === want) { return id; }
    }
    return undefined;
}
