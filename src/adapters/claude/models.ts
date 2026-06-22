/**
 * Known Claude model ids used as a fallback when remote discovery is
 * unavailable (e.g. the CLI authenticates without ANTHROPIC_API_KEY, so the
 * /v1/models endpoint can't be queried). Keeps the model picker populated.
 */
export const CLAUDE_FALLBACK_MODELS: string[] = [
    "claude-opus-4-1",
    "claude-opus-4-0",
    "claude-sonnet-4-5",
    "claude-sonnet-4-0",
    "claude-3-7-sonnet-latest",
    "claude-3-5-haiku-latest",
];

export const CLAUDE_FALLBACK_LABELS: Record<string, string> = {
    "claude-opus-4-1": "Claude Opus 4.1",
    "claude-opus-4-0": "Claude Opus 4",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-4-0": "Claude Sonnet 4",
    "claude-3-7-sonnet-latest": "Claude Sonnet 3.7",
    "claude-3-5-haiku-latest": "Claude Haiku 3.5",
};
