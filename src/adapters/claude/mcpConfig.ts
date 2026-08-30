import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
    SUFFICIT_IDENTITY_MCP_SERVER,
    SUFFICIT_MCP_SERVER,
    buildAutomaticSufficitMcpServers,
    currentSufficitIdentityMcpUrl,
    currentSufficitMcpToken,
    isAutomaticSufficitMcpName,
    shouldRestartSufficitMcp,
    type GuardrailOrigin,
} from "../sufficitMcp";

export interface ClaudeMcpConfigResult {
    path?: string;
    guardrailSessionId?: string;
    guardrailToken?: string;
    identityUrl?: string;
}

export function buildClaudeMcpConfig(
    config: {
        mcpServers?: Record<string, unknown>;
        playwright?: boolean;
        log?: (message: string) => void;
    },
    sessionId: string | undefined,
    origin: GuardrailOrigin | undefined,
    permission: string | undefined,
): ClaudeMcpConfigResult {
    const servers: Record<string, unknown> = { ...(config.mcpServers ?? {}) };
    for (const name of Object.keys(servers)) {
        if (isAutomaticSufficitMcpName(name)) delete servers[name];
    }
    const token = currentSufficitMcpToken();
    const automatic = buildAutomaticSufficitMcpServers(
        token,
        sessionId,
        "vscode-claude",
        origin,
        permission,
    );
    Object.assign(servers, automatic);
    if (config.playwright && !servers.playwright) {
        servers.playwright = {
            command: "npx",
            args: ["-y", "@playwright/mcp@latest", "--browser", "chromium"],
        };
    }
    if (Object.keys(servers).length === 0) return {};
    try {
        const dir = path.join(os.homedir(), ".symposium");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "claude-mcp.json");
        fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
        fs.chmodSync(file, 0o600);
        return {
            path: file,
            guardrailSessionId: automatic[SUFFICIT_MCP_SERVER] ? sessionId?.trim() : undefined,
            guardrailToken: Object.keys(automatic).length ? (token ?? undefined) : undefined,
            identityUrl: automatic[SUFFICIT_IDENTITY_MCP_SERVER]
                ? currentSufficitIdentityMcpUrl()
                : undefined,
        };
    } catch (error) {
        config.log?.(`[claude] mcp config write failed: ${error}`);
        return {};
    }
}

export function shouldRestartClaudeMcp(
    sessionId: string | undefined,
    origin: GuardrailOrigin | undefined,
    permission: string | undefined,
    spawned: Pick<ClaudeMcpConfigResult, "guardrailSessionId" | "guardrailToken" | "identityUrl">,
): boolean {
    return shouldRestartSufficitMcp(
        currentSufficitMcpToken(),
        sessionId,
        "vscode-claude",
        origin,
        permission,
        spawned.guardrailSessionId,
        spawned.guardrailToken,
        spawned.identityUrl,
    );
}
