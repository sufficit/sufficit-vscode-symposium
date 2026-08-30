import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchClaudeUsage } from "../adapters/claude/usage";

test("retries Claude usage once with a forced OAuth refresh after HTTP 401", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-claude-auth-"));
    const credentialsFile = path.join(configDir, ".credentials.json");
    fs.writeFileSync(
        credentialsFile,
        JSON.stringify({
            claudeAiOauth: {
                accessToken: "stale-access-token",
                refreshToken: "long-lived-refresh-token",
                // The token is locally fresh, but the server has already
                // revoked it. This is the overnight failure reported by users.
                expiresAt: Date.now() + 60 * 60 * 1000,
            },
        }),
        { mode: 0o600 },
    );

    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    process.env.CLAUDE_CONFIG_DIR = configDir;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        const [input] = args;
        const url = String(input);
        calls.push(url);
        if (url.includes("/api/oauth/usage")) {
            if (calls.filter((call) => call.includes("/api/oauth/usage")).length === 1) {
                return Promise.resolve(new Response(null, { status: 401 }));
            }
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        five_hour: { utilization: 12, resets_at: "2026-08-19T18:00:00Z" },
                        seven_day: { utilization: 24, resets_at: "2026-08-24T18:00:00Z" },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );
        }
        assert.match(url, /oauth\/token$/);
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    access_token: "refreshed-access-token",
                    refresh_token: "rotated-refresh-token",
                    expires_in: 3600,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            ),
        );
    }) as typeof fetch;

    try {
        const result = await fetchClaudeUsage();
        assert.deepEqual(
            result.snapshot?.windows.map((window) => [window.id, window.usedPercent]),
            [
                ["five_hour", 12],
                ["seven_day", 24],
            ],
        );
        assert.deepEqual(calls, [
            "https://api.anthropic.com/api/oauth/usage",
            "https://console.anthropic.com/v1/oauth/token",
            "https://api.anthropic.com/api/oauth/usage",
        ]);
        assert.match(fs.readFileSync(credentialsFile, "utf8"), /refreshed-access-token/);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        fs.rmSync(configDir, { recursive: true, force: true });
    }
});
