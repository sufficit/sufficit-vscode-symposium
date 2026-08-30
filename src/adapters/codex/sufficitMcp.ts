import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    SUFFICIT_IDENTITY_MCP_SERVER,
    SUFFICIT_MCP_CONTEXT_ID,
    SUFFICIT_MCP_SERVER,
    SUFFICIT_MCP_SESSION_HEADER,
    SUFFICIT_MCP_TOKEN_ENV,
    SUFFICIT_MCP_URL,
    SUFFICIT_MCP_ORIGIN_HEADER,
    applySufficitMcpToken,
    currentSufficitIdentityMcpUrl,
    resolveSufficitMcpToken,
    setSufficitMcpTokenProvider,
} from "../sufficitMcp";

export {
    SUFFICIT_IDENTITY_MCP_SERVER,
    SUFFICIT_IDENTITY_MCP_URL,
    SUFFICIT_MCP_CONTEXT_ID,
    SUFFICIT_MCP_SERVER,
    SUFFICIT_MCP_TOKEN_ENV,
    SUFFICIT_MCP_URL,
} from "../sufficitMcp";
export const SUFFICIT_MCP_SOURCE_ID = "vscode-codex";

export function setCodexSufficitTokenProvider(
    provider: ((forceRefresh?: boolean) => Promise<string | null>) | undefined,
): void {
    setSufficitMcpTokenProvider(provider);
}

export async function resolveCodexSufficitToken(forceRefresh = false): Promise<string | null> {
    return resolveSufficitMcpToken(forceRefresh);
}

export function applyCodexSufficitToken(token: string | null | undefined): void {
    applySufficitMcpToken(token);
}

function sectionHeader(server = SUFFICIT_MCP_SERVER): string {
    return `[mcp_servers.${server}]`;
}

export function buildSufficitMcpSection(
    enabled: boolean,
    sessionId?: string,
    origin: "user-approved" | "agent-requested" = "agent-requested",
    permission?: string,
): string {
    const headers = [
        `X-MEMORY-CONTEXT-ID = ${JSON.stringify(SUFFICIT_MCP_CONTEXT_ID)}`,
        `X-MEMORY-SOURCE-ID = ${JSON.stringify(SUFFICIT_MCP_SOURCE_ID)}`,
    ];
    if (sessionId?.trim()) {
        headers.push(`${SUFFICIT_MCP_SESSION_HEADER} = ${JSON.stringify(sessionId.trim())}`);
        headers.push(`${SUFFICIT_MCP_ORIGIN_HEADER} = ${JSON.stringify(origin)}`);
        if (permission) {
            headers.push(`X-SYMPOSIUM-PERMISSION-MODE = ${JSON.stringify(permission)}`);
        }
    }
    return [
        sectionHeader(SUFFICIT_MCP_SERVER),
        `enabled = ${enabled ? "true" : "false"}`,
        `url = ${JSON.stringify(SUFFICIT_MCP_URL)}`,
        `bearer_token_env_var = ${JSON.stringify(SUFFICIT_MCP_TOKEN_ENV)}`,
        `[mcp_servers.${SUFFICIT_MCP_SERVER}.http_headers]`,
        ...headers,
    ].join("\n");
}

export function buildSufficitIdentityMcpSection(
    enabled: boolean,
    url = currentSufficitIdentityMcpUrl(),
): string {
    return [
        sectionHeader(SUFFICIT_IDENTITY_MCP_SERVER),
        `enabled = ${enabled ? "true" : "false"}`,
        `url = ${JSON.stringify(url)}`,
        `bearer_token_env_var = ${JSON.stringify(SUFFICIT_MCP_TOKEN_ENV)}`,
    ].join("\n");
}

export function hasSufficitMcpSection(content: string): boolean {
    return hasMcpSection(content, SUFFICIT_MCP_SERVER);
}

export function hasSufficitIdentityMcpSection(content: string): boolean {
    return hasMcpSection(content, SUFFICIT_IDENTITY_MCP_SERVER);
}

function hasMcpSection(content: string, server: string): boolean {
    return content
        .replace(/\r\n/g, "\n")
        .split("\n")
        .some((line) => line.trim() === sectionHeader(server));
}

export function upsertSufficitMcpSection(
    content: string,
    enabled: boolean,
    sessionId?: string,
    origin: "user-approved" | "agent-requested" = "agent-requested",
    permission?: string,
): string {
    return upsertMcpSection(
        content,
        SUFFICIT_MCP_SERVER,
        buildSufficitMcpSection(enabled, sessionId, origin, permission),
    );
}

export function upsertSufficitIdentityMcpSection(
    content: string,
    enabled: boolean,
    url = currentSufficitIdentityMcpUrl(),
): string {
    return upsertMcpSection(
        content,
        SUFFICIT_IDENTITY_MCP_SERVER,
        buildSufficitIdentityMcpSection(enabled, url),
    );
}

function upsertMcpSection(content: string, server: string, section: string): string {
    const normalized = content.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const start = lines.findIndex((line) => line.trim() === sectionHeader(server));
    const block = section.split("\n");
    if (start < 0) {
        const trimmed = normalized.trimEnd();
        return trimmed ? `${trimmed}\n\n${block.join("\n")}\n` : `${block.join("\n")}\n`;
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        if (
            trimmed.startsWith("[") &&
            trimmed.endsWith("]") &&
            !trimmed.startsWith(`[mcp_servers.${server}.`)
        ) {
            end = i;
            break;
        }
    }
    const suffix = lines.slice(end);
    const separator = suffix.length && suffix[0].trim() ? [""] : [];
    return `${[...lines.slice(0, start), ...block, ...separator, ...suffix]
        .join("\n")
        .trimEnd()}\n`;
}

export function syncSufficitMcpConfig(
    token: string | null | undefined,
    homeDir = os.homedir(),
    sessionId?: string,
    origin: "user-approved" | "agent-requested" = "agent-requested",
    requireSession = false,
    permission?: string,
): {
    configPath: string;
    enabled: boolean;
    identityEnabled: boolean;
    changed: boolean;
} {
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const enabled = !!token && (!requireSession || !!sessionId?.trim());
    const identityEnabled = !!token;
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    if (
        !enabled &&
        !identityEnabled &&
        !hasSufficitMcpSection(current) &&
        !hasSufficitIdentityMcpSection(current)
    ) {
        return { configPath, enabled, identityEnabled, changed: false };
    }
    const withAi = upsertSufficitMcpSection(current, enabled, sessionId, origin, permission);
    const next = upsertSufficitIdentityMcpSection(withAi, identityEnabled);
    if (next === current) {
        return { configPath, enabled, identityEnabled, changed: false };
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, next, "utf8");
    return { configPath, enabled, identityEnabled, changed: true };
}

export async function syncCodexSufficitMcp(
    forceRefresh = false,
    homeDir?: string,
    sessionId?: string,
    origin: "user-approved" | "agent-requested" = "agent-requested",
    requireSession = false,
    permission?: string,
): Promise<{
    configPath: string;
    enabled: boolean;
    identityEnabled: boolean;
    changed: boolean;
}> {
    const token = await resolveCodexSufficitToken(forceRefresh);
    applyCodexSufficitToken(token);
    return syncSufficitMcpConfig(token, homeDir, sessionId, origin, requireSession, permission);
}
