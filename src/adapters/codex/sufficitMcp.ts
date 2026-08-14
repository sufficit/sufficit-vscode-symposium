import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    SUFFICIT_MCP_CONTEXT_ID,
    SUFFICIT_MCP_SERVER,
    SUFFICIT_MCP_SESSION_HEADER,
    SUFFICIT_MCP_TOKEN_ENV,
    SUFFICIT_MCP_URL,
    SUFFICIT_MCP_ORIGIN_HEADER,
    applySufficitMcpToken,
    resolveSufficitMcpToken,
    setSufficitMcpTokenProvider,
} from "../sufficitMcp";

export {
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

function sectionHeader(): string {
    return `[mcp_servers.${SUFFICIT_MCP_SERVER}]`;
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
        sectionHeader(),
        `enabled = ${enabled ? "true" : "false"}`,
        `url = ${JSON.stringify(SUFFICIT_MCP_URL)}`,
        `bearer_token_env_var = ${JSON.stringify(SUFFICIT_MCP_TOKEN_ENV)}`,
        `[mcp_servers.${SUFFICIT_MCP_SERVER}.http_headers]`,
        ...headers,
    ].join("\n");
}

export function hasSufficitMcpSection(content: string): boolean {
    return content
        .replace(/\r\n/g, "\n")
        .split("\n")
        .some((line) => line.trim() === sectionHeader());
}

export function upsertSufficitMcpSection(
    content: string,
    enabled: boolean,
    sessionId?: string,
    origin: "user-approved" | "agent-requested" = "agent-requested",
    permission?: string,
): string {
    const normalized = content.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const start = lines.findIndex((line) => line.trim() === sectionHeader());
    const block = buildSufficitMcpSection(enabled, sessionId, origin, permission).split("\n");
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
            !trimmed.startsWith(`[mcp_servers.${SUFFICIT_MCP_SERVER}.`)
        ) {
            end = i;
            break;
        }
    }
    return `${[...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n").trimEnd()}\n`;
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
    changed: boolean;
} {
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const enabled = !!token && (!requireSession || !!sessionId?.trim());
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    if (!enabled && !hasSufficitMcpSection(current)) {
        return { configPath, enabled, changed: false };
    }
    const next = upsertSufficitMcpSection(current, enabled, sessionId, origin, permission);
    if (next === current) {
        return { configPath, enabled, changed: false };
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, next, "utf8");
    return { configPath, enabled, changed: true };
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
    changed: boolean;
}> {
    const token = await resolveCodexSufficitToken(forceRefresh);
    applyCodexSufficitToken(token);
    return syncSufficitMcpConfig(token, homeDir, sessionId, origin, requireSession, permission);
}
