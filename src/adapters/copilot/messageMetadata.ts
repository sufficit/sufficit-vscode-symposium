/** Extracts the per-reply model and effort fields from a Copilot transcript event. */
export function copilotMessageMetadata(
    event: Record<string, unknown>,
    data: Record<string, unknown>,
): { model?: string; reasoning?: string } {
    const model = event.model ?? data.model;
    const effort =
        event.effort ?? event.reasoning ?? data.effort ?? data.reasoning ?? data.reasoningEffort;
    return {
        ...(typeof model === "string" && model ? { model } : {}),
        ...(typeof effort === "string" && effort ? { reasoning: effort } : {}),
    };
}
