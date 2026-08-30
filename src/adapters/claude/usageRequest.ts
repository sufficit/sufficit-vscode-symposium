const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/** Fetch one live Claude account-usage snapshot with a bounded request. */
export async function requestClaudeUsage(accessToken: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
        return await fetch(USAGE_ENDPOINT, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "anthropic-beta": "oauth-2025-04-20",
                "user-agent": "sufficit-vscode-symposium/claude-usage",
            },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}
