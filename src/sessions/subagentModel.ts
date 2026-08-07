import type { AgentAdapter } from "../adapters/types";
import { resolveModelPin } from "../application/modelSelection";

function parseList(value: string): string[] {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function matchAny(constraint: string, value: string): boolean {
    return parseList(constraint).some((pattern) => {
        const escaped = pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");
        return new RegExp(`^${escaped}$`, "i").test(value);
    });
}

function firstConcrete(constraint: string): string | undefined {
    return parseList(constraint).find((item) => !/[*?]/.test(item));
}

function isDefaultModel(value: string): boolean {
    return !value || value.toLowerCase() === "default" || value.toLowerCase() === "auto";
}

/** Resolves an agent-def/model-tool value into an adapter-safe model id. */
export async function resolveSubagentModel(
    adapter: AgentAdapter,
    definition: string,
    requested: string,
): Promise<{ model?: string; error?: string }> {
    const defModel = definition.trim();
    const modelConstraint = isDefaultModel(defModel) ? "" : defModel;
    const reqModel = requested.trim();
    const requestedModel = isDefaultModel(reqModel) ? "" : reqModel;
    const rawModel = requestedModel || firstConcrete(modelConstraint) || "";
    if (modelConstraint && rawModel && !matchAny(modelConstraint, rawModel)) {
        return { error: `model '${rawModel}' does not satisfy '${modelConstraint}'` };
    }
    let model = rawModel || undefined;
    if (model && adapter.modelLabels) {
        const resolved = await resolveModelPin(adapter, model);
        if (resolved) {
            model = resolved;
        } else if (!(adapter.models?.() ?? []).includes(model)) {
            return { error: `model '${model}' is not available in the adapter catalog` };
        }
    }
    return { model };
}
