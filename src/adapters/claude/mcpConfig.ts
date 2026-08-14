import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
    buildSufficitMcpServer,
    currentSufficitMcpToken,
    isSufficitMcpName,
    type GuardrailOrigin,
} from "../sufficitMcp";

export interface ClaudeMcpConfigResult {
    path?: string;
    guardrailSessionId?: string;
    guardrailToken?: string;
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
        if (isSufficitMcpName(name)) delete servers[name];
    }
    const token = currentSufficitMcpToken();
    const sufficit = buildSufficitMcpServer(token, sessionId, "vscode-claude", origin, permission);
    if (sufficit) servers.sufficit_ai = sufficit;
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
            guardrailSessionId: sufficit ? sessionId?.trim() : undefined,
            guardrailToken: sufficit ? (token ?? undefined) : undefined,
        };
    } catch (error) {
        config.log?.(`[claude] mcp config write failed: ${error}`);
        return {};
    }
}
