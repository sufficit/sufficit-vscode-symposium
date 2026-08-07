export function parseCodexModelCatalog(
    json: unknown,
    configured = "",
): { models: string[]; labels: Record<string, string> } {
    const root = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
    const raw = Array.isArray(root.models) ? root.models : Array.isArray(json) ? json : [];
    const entries: Array<{ id: string; priority: number; index: number }> = [];
    const labels: Record<string, string> = {};
    raw.forEach((item, index) => {
        if (typeof item !== "object" || item === null) {
            return;
        }
        const model = item as Record<string, unknown>;
        const id =
            typeof model.slug === "string"
                ? model.slug
                : typeof model.id === "string"
                  ? model.id
                  : "";
        if (!id || model.visibility === "hide") {
            return;
        }
        const priority =
            typeof model.priority === "number" ? model.priority : Number.POSITIVE_INFINITY;
        entries.push({ id, priority, index });
        const label =
            typeof model.display_name === "string"
                ? model.display_name
                : typeof model.name === "string"
                  ? model.name
                  : "";
        if (label && label !== id) {
            labels[id] = label;
        }
    });
    entries.sort((a, b) => a.priority - b.priority || a.index - b.index);
    const discovered = entries.map((entry) => entry.id);
    return {
        models: [...new Set([...(configured ? [configured] : []), ...discovered])],
        labels,
    };
}
