/** Shared authenticated MCP contract used by the CLI adapters. */

export const SUFFICIT_MCP_SERVER = "sufficit_ai";
export const SUFFICIT_MCP_URL = "https://ai.sufficit.com.br/mcp";
export const SUFFICIT_IDENTITY_MCP_SERVER = "sufficit_identity";
export const SUFFICIT_IDENTITY_MCP_URL = "https://identity.sufficit.com.br/api/mcp";
export const SUFFICIT_MCP_TOKEN_ENV = "SYMPOSIUM_SUFFICIT_MCP_TOKEN";
export const SUFFICIT_MCP_CONTEXT_ID = "d21cfb04-9d37-473b-837c-67591a26feed";
export const SUFFICIT_MCP_SESSION_HEADER = "X-SYMPOSIUM-SESSION-ID";
export const SUFFICIT_MCP_ORIGIN_HEADER = "X-SYMPOSIUM-GUARDRAIL-ORIGIN";
export const SUFFICIT_MCP_PERMISSION_HEADER = "X-SYMPOSIUM-PERMISSION-MODE";

export type GuardrailOrigin = "user-approved" | "agent-requested";
export type SufficitMcpTokenProvider = (forceRefresh?: boolean) => Promise<string | null>;

let tokenProvider: SufficitMcpTokenProvider | undefined;
let identityMcpUrl = SUFFICIT_IDENTITY_MCP_URL;

export function isSufficitMcpName(name: string): boolean {
    return name.replace(/[^a-z0-9]/gi, "").toLowerCase() === "sufficitai";
}

export function isSufficitIdentityMcpName(name: string): boolean {
    return name.replace(/[^a-z0-9]/gi, "").toLowerCase() === "sufficitidentity";
}

export function isAutomaticSufficitMcpName(name: string): boolean {
    return isSufficitMcpName(name) || isSufficitIdentityMcpName(name);
}

export function setSufficitIdentityMcpUrl(url: string | undefined): void {
    const normalized = url?.trim().replace(/\/+$/, "");
    identityMcpUrl = normalized || SUFFICIT_IDENTITY_MCP_URL;
}

export function currentSufficitIdentityMcpUrl(): string {
    return identityMcpUrl;
}

export function setSufficitMcpTokenProvider(provider: SufficitMcpTokenProvider | undefined): void {
    tokenProvider = provider;
}

export async function resolveSufficitMcpToken(forceRefresh = false): Promise<string | null> {
    try {
        return (await tokenProvider?.(forceRefresh)) ?? null;
    } catch {
        return null;
    }
}

/** Keeps the token out of command-line arguments; generated config files are mode 0600. */
export function applySufficitMcpToken(token: string | null | undefined): void {
    if (token) {
        process.env[SUFFICIT_MCP_TOKEN_ENV] = token;
    } else {
        delete process.env[SUFFICIT_MCP_TOKEN_ENV];
    }
}

export function currentSufficitMcpToken(): string | null {
    return process.env[SUFFICIT_MCP_TOKEN_ENV] || null;
}

export function shouldRestartSufficitMcp(
    token: string | null,
    sessionId: string | undefined,
    sourceId: string,
    origin: GuardrailOrigin | undefined,
    permission: string | undefined,
    spawnedSessionId: string | undefined,
    spawnedToken: string | undefined,
    spawnedIdentityUrl?: string,
): boolean {
    const ready = buildSufficitMcpServer(token, sessionId, sourceId, origin, permission);
    const identity = buildSufficitIdentityMcpServer(token);
    const nextToken = ready || identity ? (token ?? undefined) : undefined;
    const nextIdentityUrl = identity ? currentSufficitIdentityMcpUrl() : undefined;
    if (spawnedToken !== nextToken || spawnedIdentityUrl !== nextIdentityUrl) {
        return true;
    }
    return ready ? spawnedSessionId !== sessionId?.trim() : !!spawnedSessionId;
}

/**
 * Creates the strict HTTP MCP shape accepted by Claude/Copilot and the VS Code
 * MCP importer. No server is returned without both a token and a session id;
 * that fail-closed rule prevents a CLI from writing another conversation's
 * guardrails when its process is started before the native id is known.
 */
export function buildSufficitMcpServer(
    token: string | null | undefined,
    sessionId: string | undefined,
    sourceId: string,
    origin: GuardrailOrigin = "agent-requested",
    permission?: string,
): Record<string, unknown> | undefined {
    // Runtime keys are placeholders before a CLI announces its durable native
    // session id. Do not expose a remote mutating tool during that window.
    if (!token || !sessionId?.trim() || /^new-\d+$/.test(sessionId.trim())) {
        return undefined;
    }
    return {
        enabled: true,
        type: "http",
        url: SUFFICIT_MCP_URL,
        headers: {
            Authorization: `Bearer ${token}`,
            "X-MEMORY-CONTEXT-ID": SUFFICIT_MCP_CONTEXT_ID,
            "X-MEMORY-SOURCE-ID": sourceId,
            [SUFFICIT_MCP_SESSION_HEADER]: sessionId.trim(),
            [SUFFICIT_MCP_ORIGIN_HEADER]: origin,
            ...(permission ? { [SUFFICIT_MCP_PERMISSION_HEADER]: permission } : {}),
        },
        timeoutMs: 60000,
    };
}

/** Identity MCP uses the logged-in subject directly and is not conversation-scoped. */
export function buildSufficitIdentityMcpServer(
    token: string | null | undefined,
    url = currentSufficitIdentityMcpUrl(),
): Record<string, unknown> | undefined {
    if (!token || !url.trim()) {
        return undefined;
    }
    return {
        enabled: true,
        type: "http",
        url: url.trim(),
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 60000,
    };
}

/** Removes aliases and supplies the two authenticated Sufficit MCP servers. */
export function buildAutomaticSufficitMcpServers(
    token: string | null | undefined,
    sessionId: string | undefined,
    sourceId: string,
    origin: GuardrailOrigin = "agent-requested",
    permission?: string,
): Record<string, unknown> {
    const servers: Record<string, unknown> = {};
    const ai = buildSufficitMcpServer(token, sessionId, sourceId, origin, permission);
    const identity = buildSufficitIdentityMcpServer(token);
    if (ai) servers[SUFFICIT_MCP_SERVER] = ai;
    if (identity) servers[SUFFICIT_IDENTITY_MCP_SERVER] = identity;
    return servers;
}
