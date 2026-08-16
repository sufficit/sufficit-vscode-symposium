/**
 * Reads the Claude Code CLI OAuth credentials (~/.claude/.credentials.json) and
 * hands out a usable bearer access token, refreshing it transparently when the
 * cached one has expired.
 *
 * Background: Claude Code (the CLI) authenticates end-users via OAuth — the
 * resulting tokens live in ~/.claude/.credentials.json under `claudeAiOauth`:
 *   { accessToken, refreshToken, expiresAt (epoch ms), scopes, ... }
 * The access token is short-lived (~8h); the refresh token is long-lived. The
 * CLI auto-refreshes via the Anthropic OAuth token endpoint (client_id
 * `claude-public`). We replicate that so model discovery (GET /v1/models) works
 * for a user who is logged in to Claude Code, WITHOUT requiring a separate
 * ANTHROPIC_API_KEY.
 *
 * This is intentionally read-mostly: it never writes secrets to logs, and the
 * refresh only updates the on-disk credentials file (same behaviour as the CLI).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Where the CLI keeps its OAuth tokens (0600, user-readable). */
export function claudeCredentialsPath(): string {
    // The CLI honours CLAUDE_CONFIG_DIR for non-default locations.
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    return path.join(dir, ".credentials.json");
}

interface StoredOAuth {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
}
interface StoredCredentials {
    claudeAiOauth?: StoredOAuth;
    organizationUuid?: string;
}

export interface ClaudeOAuthMetadata {
    subscriptionType?: string;
    rateLimitTier?: string;
}

/** Slack (s): treat a token as expired slightly before its real expiry. */
const EXPIRY_SKEW_MS = 60_000;

const TOKEN_ENDPOINTS = [
    "https://console.anthropic.com/v1/oauth/token",
    "https://platform.claude.com/v1/oauth/token",
];
const CLIENT_ID = "claude-public";
let refreshInFlight: Promise<string | undefined> | undefined;

/** Reads (and parses) the credentials file; returns undefined if absent/invalid. */
function readCredentials(): StoredCredentials | undefined {
    const file = claudeCredentialsPath();
    let raw: string;
    try {
        raw = fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
    try {
        return JSON.parse(raw) as StoredCredentials;
    } catch {
        return undefined;
    }
}

function isFresh(oauth: StoredOAuth): boolean {
    return typeof oauth.expiresAt === "number" && oauth.expiresAt - Date.now() > EXPIRY_SKEW_MS;
}

function normalizeExpiresAt(value: unknown, fallback: number | undefined): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    // OAuth providers commonly return epoch seconds while the CLI stores
    // milliseconds. Keep the on-disk representation consistent.
    return value < 10_000_000_000 ? value * 1000 : value;
}

/**
 * Refreshes the access token using the stored refresh token, persisting the new
 * pair back to the credentials file. Returns the new access token, or undefined
 * on failure (caller falls back to whatever it had).
 */
async function refresh(oauth: StoredOAuth): Promise<string | undefined> {
    if (!oauth.refreshToken) {
        return undefined;
    }
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: CLIENT_ID,
    }).toString();

    for (const endpoint of TOKEN_ENDPOINTS) {
        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body,
            });
            if (!res.ok) {
                continue;
            } // try the next endpoint (the legacy URL 404s now)
            const json = (await res.json()) as {
                access_token?: string;
                refresh_token?: string;
                expires_in?: number;
                expires_at?: number;
            };
            if (!json.access_token) {
                continue;
            }
            const next: StoredOAuth = {
                ...oauth,
                accessToken: json.access_token,
                refreshToken: json.refresh_token || oauth.refreshToken,
                expiresAt: normalizeExpiresAt(
                    json.expires_at,
                    json.expires_in ? Date.now() + json.expires_in * 1000 : oauth.expiresAt,
                ),
            };
            // Persist the refreshed pair so the CLI (and the next refreshModels)
            // see the same token, mirroring what Claude Code itself does.
            persist(next);
            return next.accessToken;
        } catch {
            // network error on this endpoint — try the next
        }
    }
    return undefined;
}

/** Writes the updated OAuth block back, preserving any sibling fields on disk. */
function persist(oauth: StoredOAuth): void {
    const file = claudeCredentialsPath();
    let current: StoredCredentials = {};
    try {
        current = JSON.parse(fs.readFileSync(file, "utf8")) as StoredCredentials;
    } catch {
        /* ignore */
    }
    current.claudeAiOauth = oauth;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
    } catch {
        // Non-fatal: the in-memory token still works for this call.
    }
}

/**
 * Returns a bearer token for the Anthropic API when the user is logged in to
 * Claude Code, refreshing on demand. Empty string when no usable credential.
 */
export async function claudeOAuthToken(): Promise<string> {
    const creds = readCredentials();
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) {
        return "";
    }
    if (isFresh(oauth)) {
        return oauth.accessToken;
    }
    // Multiple code-server windows can ask for the token at the same time.
    // Share one refresh request in this extension host to avoid rotating the
    // same refresh token concurrently.
    refreshInFlight ??= refresh(oauth).finally(() => {
        refreshInFlight = undefined;
    });
    const refreshed = await refreshInFlight;
    if (refreshed) {
        return refreshed;
    }

    // A transient refresh failure is not proof of logout. The CLI may still
    // accept the current access token, and another code-server window may have
    // persisted a newer token while this request was in flight.
    const latest = readCredentials()?.claudeAiOauth;
    return latest?.accessToken || oauth.accessToken;
}

/** Non-secret account labels stored alongside the Claude OAuth token. */
export function claudeOAuthMetadata(): ClaudeOAuthMetadata {
    const oauth = readCredentials()?.claudeAiOauth;
    return {
        ...(oauth?.subscriptionType ? { subscriptionType: oauth.subscriptionType } : {}),
        ...(oauth?.rateLimitTier ? { rateLimitTier: oauth.rateLimitTier } : {}),
    };
}
