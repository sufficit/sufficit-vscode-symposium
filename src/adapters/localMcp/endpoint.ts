/**
 * Connection contract between the in-process local MCP server and the CLI
 * adapters. The server publishes its endpoint here once it is listening; each
 * adapter asks for the config entry of ITS conversation when it spawns a CLI.
 */
import { LOCAL_MCP_SESSION_HEADER, type LocalMcpEndpoint } from "./server";

export const LOCAL_MCP_SERVER = "symposium";
export const LOCAL_MCP_TOKEN_ENV = "SYMPOSIUM_LOCAL_MCP_TOKEN";
/** Full tool name as Claude Code (and Codex) expose it to the model. */
export const LOCAL_MCP_READ_SESSION_TOOL = `mcp__${LOCAL_MCP_SERVER}__read_session`;

let endpoint: LocalMcpEndpoint | undefined;

/**
 * Publishes (or clears) the running endpoint. The token also lives in this
 * process' environment so CLIs inherit it and no config file has to contain it.
 */
export function setLocalMcpEndpoint(next: LocalMcpEndpoint | undefined): void {
    endpoint = next;
    if (next) {
        process.env[LOCAL_MCP_TOKEN_ENV] = next.token;
    } else {
        delete process.env[LOCAL_MCP_TOKEN_ENV];
    }
}

export function currentLocalMcpUrl(): string | undefined {
    return endpoint?.url;
}

export function isLocalMcpName(name: string): boolean {
    return name.trim().toLowerCase() === LOCAL_MCP_SERVER;
}

/**
 * Config entry for CLIs that read a JSON MCP config (Claude, Copilot). The
 * token is referenced as an environment variable, never written to disk.
 */
export function buildLocalMcpServer(
    sessionId: string | undefined,
): Record<string, unknown> | undefined {
    if (!endpoint) {
        return undefined;
    }
    const id = sessionId?.trim();
    return {
        enabled: true,
        type: "http",
        url: endpoint.url,
        headers: {
            Authorization: `Bearer \${${LOCAL_MCP_TOKEN_ENV}}`,
            ...(id ? { [LOCAL_MCP_SESSION_HEADER]: id } : {}),
        },
        timeoutMs: 60000,
    };
}

/** `-c` overrides that register the same server for `codex exec`. */
export function buildLocalMcpCodexArgs(sessionId: string | undefined): string[] {
    if (!endpoint) {
        return [];
    }
    const prefix = `mcp_servers.${LOCAL_MCP_SERVER}`;
    const id = sessionId?.trim();
    const headers = id
        ? `{ ${JSON.stringify(LOCAL_MCP_SESSION_HEADER)} = ${JSON.stringify(id)} }`
        : "{}";
    return [
        "-c",
        `${prefix}.url=${JSON.stringify(endpoint.url)}`,
        "-c",
        `${prefix}.bearer_token_env_var=${JSON.stringify(LOCAL_MCP_TOKEN_ENV)}`,
        "-c",
        `${prefix}.http_headers=${headers}`,
    ];
}
