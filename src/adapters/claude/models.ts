/**
 * Deprecated: No hardcoded models.
 *
 * Models should always be discovered via refreshModels() from the Anthropic API.
 * If refresh fails (e.g., no ANTHROPIC_API_KEY), the picker will show empty state.
 *
 * @deprecated Kept for backward compatibility; always returns empty arrays.
 */
export const CLAUDE_FALLBACK_MODELS: string[] = [];

export const CLAUDE_FALLBACK_LABELS: Record<string, string> = {};
