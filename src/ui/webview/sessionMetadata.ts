/** Metadata shown for a stored conversation in the sessions navigator. */
export interface SessionMetadataInput {
    backend: string;
    backendName?: string;
    model?: string;
    reasoning?: string;
    updatedAt?: string;
    relativeTime?: string;
}

export interface SessionMetadataView {
    visible: string;
    tooltip: string;
}

/** Builds one compact line plus a complete hover description for a session. */
export function sessionMetadata(input: SessionMetadataInput): SessionMetadataView {
    const adapter = input.backendName || input.backend;
    const model = input.model?.trim();
    const reasoning = input.reasoning?.trim();
    const visible = [
        adapter,
        model ? `model: ${model}` : "",
        reasoning ? `effort: ${reasoning}` : "",
        input.relativeTime || "",
    ].filter(Boolean);
    const tooltip = [
        `Adapter: ${adapter}`,
        model ? `Model: ${model}` : "Model: unavailable",
        reasoning ? `Effort: ${reasoning}` : "Effort: unavailable",
        input.updatedAt ? `Updated: ${new Date(input.updatedAt).toLocaleString()}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    return { visible: visible.join(" · "), tooltip };
}
