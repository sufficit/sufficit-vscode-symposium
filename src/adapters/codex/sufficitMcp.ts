import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const SUFFICIT_MCP_SERVER = "sufficit_ai";
export const SUFFICIT_MCP_URL = "https://ai.sufficit.com.br/mcp";
export const SUFFICIT_MCP_TOKEN_ENV = "SYMPOSIUM_SUFFICIT_MCP_TOKEN";
export const SUFFICIT_MCP_CONTEXT_ID = "d21cfb04-9d37-473b-837c-67591a26feed";
export const SUFFICIT_MCP_SOURCE_ID = "vscode-codex";

type TokenProvider = (forceRefresh?: boolean) => Promise<string | null>;
let tokenProvider: TokenProvider | undefined;

export function setCodexSufficitTokenProvider(provider: TokenProvider | undefined): void {
    tokenProvider = provider;
}

export async function resolveCodexSufficitToken(forceRefresh = false): Promise<string | null> {
    try {
        return (await tokenProvider?.(forceRefresh)) ?? null;
    } catch {
        return null;
    }
}

export function applyCodexSufficitToken(token: string | null | undefined): void {
    if (token) {
        process.env[SUFFICIT_MCP_TOKEN_ENV] = token;
        return;
    }
    delete process.env[SUFFICIT_MCP_TOKEN_ENV];
}

function sectionHeader(): string {
    return `[mcp_servers.${SUFFICIT_MCP_SERVER}]`;
}

export function buildSufficitMcpSection(enabled: boolean): string {
    return [
        sectionHeader(),
        `enabled = ${enabled ? "true" : "false"}`,
        `url = ${JSON.stringify(SUFFICIT_MCP_URL)}`,
        `bearer_token_env_var = ${JSON.stringify(SUFFICIT_MCP_TOKEN_ENV)}`,
        `[mcp_servers.${SUFFICIT_MCP_SERVER}.http_headers]`,
        `X-MEMORY-CONTEXT-ID = ${JSON.stringify(SUFFICIT_MCP_CONTEXT_ID)}`,
        `X-MEMORY-SOURCE-ID = ${JSON.stringify(SUFFICIT_MCP_SOURCE_ID)}`,
    ].join("\n");
}

export function hasSufficitMcpSection(content: string): boolean {
    return content
        .replace(/\r\n/g, "\n")
        .split("\n")
        .some((line) => line.trim() === sectionHeader());
}

export function upsertSufficitMcpSection(content: string, enabled: boolean): string {
    const normalized = content.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const start = lines.findIndex((line) => line.trim() === sectionHeader());
    const block = buildSufficitMcpSection(enabled).split("\n");
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
): {
    configPath: string;
    enabled: boolean;
    changed: boolean;
} {
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const enabled = !!token;
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    if (!enabled && !hasSufficitMcpSection(current)) {
        return { configPath, enabled, changed: false };
    }
    const next = upsertSufficitMcpSection(current, enabled);
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
): Promise<{
    configPath: string;
    enabled: boolean;
    changed: boolean;
}> {
    const token = await resolveCodexSufficitToken(forceRefresh);
    applyCodexSufficitToken(token);
    return syncSufficitMcpConfig(token, homeDir);
}
