import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CodexAdapterConfig {
    executable: string;
    model: string;
    reasoning: string;
    approvalPolicy: string;
    sandboxMode: string;
    /** VS Code workspace roots that should be writable in workspace-write mode. */
    workspaceDirs?: string[];
    /** Add the Playwright MCP server (browser navigation tools). */
    playwright?: boolean;
    /** Extra MCP servers ({ name: { command, args } }). */
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

export function codexWorkspaceArgs(cwd: string, workspaceDirs: readonly string[] = []): string[] {
    const args = ["--cd", cwd];
    const cwdResolved = path.resolve(cwd);
    const added = new Set<string>();
    for (const dir of workspaceDirs) {
        if (!dir || !path.isAbsolute(dir)) {
            continue;
        }
        const resolved = path.resolve(dir);
        if (resolved === cwdResolved || added.has(resolved)) {
            continue;
        }
        added.add(resolved);
        args.push("--add-dir", resolved);
    }
    return args;
}

/**
 * Reads VSCode's mcp.json (~/.config/Code/User/mcp.json on Linux, appropriate
 * location on Windows/macOS) and converts MCP servers to CLI-compatible format
 * for Codex. HTTP servers are converted to a command+args wrapper that uses
 * curl to communicate with the server via stdin/stdout.
 */
export function loadVscodeMcpServers(): Record<string, { command: string; args: string[] }> {
    const result: Record<string, { command: string; args: string[] }> = {};
    try {
        let configPath: string;
        const platform = os.platform();
        if (platform === "linux" || platform === "darwin") {
            configPath = path.join(os.homedir(), ".config", "Code", "User", "mcp.json");
        } else if (platform === "win32") {
            configPath = path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "mcp.json");
        } else {
            return result; // Unsupported platform
        }

        if (!fs.existsSync(configPath)) {
            return result;
        }

        const configContent = fs.readFileSync(configPath, "utf8");
        const config = JSON.parse(configContent);

        if (!config.servers || typeof config.servers !== "object") {
            return result;
        }

        for (const [name, server] of Object.entries(config.servers)) {
            const s = server as Record<string, unknown>;
            if (s.type === "http" && s.url && typeof s.url === "string") {
                // HTTP MCP servers need to communicate via HTTP POST. The
                // wrapper reads url/headers from mcp.json at runtime so secrets
                // are not baked into generated code under ~/.symposium.
                const wrapperPath = mcpHttpWrapperPath(name);
                const wrapperScript = buildHttpMcpWrapperScript(configPath, name);
                const dir = path.dirname(wrapperPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(wrapperPath, wrapperScript, { encoding: "utf8", mode: 0o600 });
                fs.chmodSync(wrapperPath, 0o600);
                result[name] = { command: "node", args: [wrapperPath] };
            } else if (s.type === "stdio" && s.command && typeof s.command === "string") {
                const args: string[] = [];
                if (Array.isArray(s.args)) {
                    args.push(...s.args);
                }
                result[name] = { command: s.command, args };
            }
        }
    } catch (error) {
        // Silently fail on errors - MCP is optional
        console.error(`[codex] Failed to load VSCode MCP config: ${error}`);
    }
    return result;
}

export function mcpHttpWrapperPath(name: string): string {
    const safeName = encodeURIComponent(name) || "server";
    return path.join(os.homedir(), ".symposium", `mcp-http-${safeName}.js`);
}

export function buildHttpMcpWrapperScript(configPath: string, serverName: string): string {
    return `
const fs = require('fs');
const http = require('http');
const https = require('https');
const readline = require('readline');

const CONFIG_PATH = ${JSON.stringify(configPath)};
const SERVER_NAME = ${JSON.stringify(serverName)};

function loadServerConfig() {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const servers = config && typeof config === 'object' ? config.servers : undefined;
    const server = servers && servers[SERVER_NAME];
    if (!server || typeof server.url !== 'string') {
        throw new Error('HTTP MCP server not found in mcp.json: ' + SERVER_NAME);
    }
    const headers = {};
    if (server.headers && typeof server.headers === 'object') {
        for (const [k, v] of Object.entries(server.headers)) {
            headers[k] = String(v);
        }
    }
    return { targetUrl: server.url, headers };
}

async function makeRequest(data) {
    const { targetUrl, headers } = loadServerConfig();
    const client = new URL(targetUrl).protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const req = client.request(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve(body);
                }
            });
        });

        req.on('error', reject);
        req.write(JSON.stringify(data));
        req.end();
    });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    try {
        const data = JSON.parse(line);
        const response = await makeRequest(data);
        console.log(JSON.stringify(response));
    } catch (err) {
        console.error(JSON.stringify({ error: err.message }));
    }
});
`;
}

/**
 * Maps the unified permission mode to Codex CLI's native approval_policy +
 * sandbox flags. admin/plan reuse real native flags 1:1 (safe: neither ever
 * asks Codex to prompt interactively). manager/user have no safe native
 * equivalent yet — Codex's own "on-request"/"on-failure" policies expect to
 * prompt over its own protocol, which Symposium doesn't answer here, so they
 * clamp to admin's flags with a one-time notice (matching the claude adapter).
 */
export function mapUnifiedToCodexFlags(
    mode: string,
    staticSandbox: string,
): { approvalPolicy: string; sandboxMode: string; unenforced: boolean } {
    switch (mode) {
        case "admin":
            return {
                approvalPolicy: "never",
                sandboxMode: "danger-full-access",
                unenforced: false,
            };
        case "plan":
            return { approvalPolicy: "never", sandboxMode: "read-only", unenforced: false };
        case "manager":
        case "user":
            return { approvalPolicy: "never", sandboxMode: "danger-full-access", unenforced: true };
        // Legacy stored value (untrusted/on-failure/on-request/never): keep the
        // static sandbox setting unchanged, exactly as before this unification.
        default:
            return { approvalPolicy: mode, sandboxMode: staticSandbox, unenforced: false };
    }
}
