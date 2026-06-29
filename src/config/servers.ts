/**
 * MCP Server Management
 *
 * Organizes MCP servers by name, each containing tools, prompts, and resources.
 * When logged into Sufficit AI, the native Sufficit MCP server is automatically included.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { repoDir, sanitize } from "./root";

/**
 * Writes `content` to `file` only when it differs from what is already on disk.
 *
 * The config panel watches `repo/**` and re-pushes state on every change, while
 * `pushState` re-asserts the built-in server (manifest + tool files). Writing
 * identical bytes still emits a watcher event, so an unconditional write creates
 * a write → watch → push → write loop (100% CPU, flickering panel). Skipping
 * no-op writes breaks that loop after it settles. Returns true if it wrote.
 */
function writeIfChanged(file: string, content: string): boolean {
    try {
        if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) {
            return false;
        }
    } catch {
        // unreadable: fall through and (re)write
    }
    fs.writeFileSync(file, content, "utf8");
    return true;
}

/** Location of servers repository */
export function serversDir(): string {
    return path.join(repoDir(), "servers");
}

/** Location of a specific server directory */
export function serverDir(serverName: string): string {
    return path.join(serversDir(), sanitize(serverName) || serverName);
}

/** Subdirectories within a server */
export function serverSubdir(serverName: string, type: "tools" | "prompts" | "resources"): string {
    return path.join(serverDir(serverName), type);
}

/** Manifest file for a server */
export function serverManifestPath(serverName: string): string {
    return path.join(serverDir(serverName), "manifest.json");
}

export interface ServerManifest {
    name: string;
    description?: string;
    version?: string;
    source?: string;
    transport?: "stdio" | "sse" | "builtin";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    /** Endpoint URL for SSE/remote transports. */
    url?: string;
    /** HTTP headers for SSE/remote transports (auth tokens, etc.). */
    headers?: Record<string, string>;
    builtin?: boolean;  // true for native Sufficit MCP
}

export interface Server {
    name: string;
    manifest: ServerManifest;
    tools: string[];
    prompts: string[];
    resources: string[];
}

/**
 * Ensures the servers directory structure exists
 */
export function ensureServersScaffold(): void {
    const servers = serversDir();
    if (!fs.existsSync(servers)) {
        fs.mkdirSync(servers, { recursive: true });
    }
}

/**
 * Reads and parses a server's manifest
 */
export function readManifest(serverName: string): ServerManifest | null {
    const manifestPath = serverManifestPath(serverName);
    if (!fs.existsSync(manifestPath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(manifestPath, "utf8");
        return JSON.parse(content) as ServerManifest;
    } catch (e) {
        console.error(`Failed to read manifest for ${serverName}:`, e);
        return null;
    }
}

/**
 * Lists all available MCP servers
 */
export function listServers(): Server[] {
    const servers = serversDir();
    if (!fs.existsSync(servers)) {
        return [];
    }

    const entries = fs.readdirSync(servers, { withFileTypes: true });
    const result: Server[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || !sanitize(entry.name)) {
            continue;
        }

        const serverName = entry.name;
        const manifest = readManifest(serverName);
        if (!manifest) {
            continue;
        }

        result.push({
            name: serverName,
            manifest,
            tools: listServerItems(serverName, "tools"),
            prompts: listServerItems(serverName, "prompts"),
            resources: listServerItems(serverName, "resources"),
        });
    }

    return result;
}

/**
 * Lists items (tools/prompts/resources) in a server subdirectory
 */
function listServerItems(serverName: string, type: "tools" | "prompts" | "resources"): string[] {
    const dir = serverSubdir(serverName, type);
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir)
        .filter(f => f.endsWith(".md") || f.endsWith(".json"))
        .map(f => f.replace(/\.(md|json)$/, ""));
}

/**
 * Creates or updates a server manifest
 */
export function writeManifest(serverName: string, manifest: ServerManifest): void {
    ensureServersScaffold();
    const server = serverDir(serverName);
    if (!fs.existsSync(server)) {
        fs.mkdirSync(server, { recursive: true });
    }

    ["tools", "prompts", "resources"].forEach(type => {
        const subdir = path.join(server, type);
        if (!fs.existsSync(subdir)) {
            fs.mkdirSync(subdir, { recursive: true });
        }
    });

    const manifestPath = serverManifestPath(serverName);
    writeIfChanged(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Writes a tool/prompt/resource into a server's subdirectory
 */
export function writeServerItem(
    serverName: string,
    type: "tools" | "prompts" | "resources",
    name: string,
    content: string
): void {
    const dir = serverSubdir(serverName, type);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const ext = type === "resources" ? ".json" : ".md";
    const filePath = path.join(dir, `${sanitize(name)}${ext}`);
    writeIfChanged(filePath, content);
}

/**
 * Deletes a server and all its contents
 */
export function deleteServer(serverName: string): boolean {
    const server = serverDir(serverName);
    if (!fs.existsSync(server)) {
        return false;
    }
    try {
        fs.rmSync(server, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.error(`Failed to delete server ${serverName}:`, e);
        return false;
    }
}

/**
 * Checks if the Sufficit AI native MCP server should be included
 * (based on whether user is logged in)
 */
export function shouldIncludeSufficitServer(): boolean {
    // This will be called by the extension to check auth state
    // For now, return false - extension will override this
    return false;
}

/**
 * Ensures the native Sufficit MCP server exists (when logged in)
 */
export function ensureSufficitNativeServer(): void {
    const serverName = "sufficit-ai";
    writeManifest(serverName, {
        name: serverName,
        description: "Native Sufficit AI MCP server (auto-detected when logged in)",
        version: "1.0.0",
        source: "builtin",
        transport: "builtin",
        builtin: true,
    });

    // Write built-in tools
    const sufficitTools = [
        { name: "memory_search", desc: "Search shared Sufficit AI memory" },
        { name: "memory_save", desc: "Persist to shared Sufficit AI memory" },
        { name: "memory_get_observations", desc: "Fetch full memory observations by IDs" },
        { name: "spawn_agent", desc: "Delegate task to another agent" },
        { name: "list_agents", desc: "List spawned subagents" },
        { name: "agent_status", desc: "Get subagent status" },
        { name: "agent_send", desc: "Send message to subagent" },
        { name: "agent_stop", desc: "Stop a subagent" },
    ];

    sufficitTools.forEach(tool => {
        const content = `---
name: ${tool.name}
description: ${tool.desc}
server: sufficit-ai
builtin: true
---

# ${tool.name}

${tool.desc}

This tool is automatically provided by the Sufficit AI MCP server when you are logged in.
`;
        writeServerItem(serverName, "tools", tool.name, content);
    });
}

/**
 * Imports MCP servers from Claude/Codex config files
 * Reorganizes them into the servers/ directory structure
 */
export interface ImportServersResult {
    serversCreated: number;
    serversSkipped: number;
    itemsCreated: number;
}

export function importServersFromConfig(): ImportServersResult {
    const result: ImportServersResult = {
        serversCreated: 0,
        serversSkipped: 0,
        itemsCreated: 0,
    };

    // Look for Codex/Claude config files
    const configPaths = [
        path.join(os.homedir(), ".codex", "config.toml"),
        path.join(os.homedir(), ".claude", "config.json"),
    ];

    for (const configPath of configPaths) {
        if (!fs.existsSync(configPath)) {
            continue;
        }

        try {
            const ext = path.extname(configPath);
            if (ext === ".toml") {
                importFromToml(configPath, result);
            } else if (ext === ".json") {
                importFromJson(configPath, result);
            }
        } catch (e) {
            console.error(`Failed to import from ${configPath}:`, e);
        }
    }

    return result;
}

function importFromToml(tomlPath: string, result: ImportServersResult): void {
    // Simple TOML parsing for mcp_servers sections
    const content = fs.readFileSync(tomlPath, "utf8");
    const lines = content.split("\n");

    let currentServer: string | null = null;
    let serverConfig: Record<string, string> = {};

    for (const line of lines) {
        const trimmed = line.trim();

        const header = /^\[mcp_servers\.([^\]]+)\]$/.exec(trimmed);
        if (header) {
            // Save previous server if exists
            if (currentServer && serverConfig.command) {
                createServerFromConfig(currentServer, serverConfig, result);
            }
            currentServer = header[1];
            serverConfig = {};
            continue;
        }

        if (!currentServer) continue;

        const keyVal = /^(\w+)\s*=\s*"([^"]*)"$/.exec(trimmed) ||
                       /^(\w+)\s*=\s*([^\s]+)$/.exec(trimmed);
        if (keyVal) {
            serverConfig[keyVal[1]] = keyVal[2];
        }
    }

    // Save last server
    if (currentServer && serverConfig.command) {
        createServerFromConfig(currentServer, serverConfig, result);
    }
}

interface JsonConfig {
    mcpServers?: Record<string, Partial<ServerManifest>>;
    servers?: Record<string, Partial<ServerManifest>>;
}

function importFromJson(jsonPath: string, result: ImportServersResult): void {
    const content = fs.readFileSync(jsonPath, "utf8");
    const config = JSON.parse(content) as JsonConfig;

    const servers = config.mcpServers || config.servers || {};
    for (const [name, serverConfig] of Object.entries(servers)) {
        createServerFromConfig(name, serverConfig as Record<string, string>, result);
    }
}

function createServerFromConfig(
    name: string,
    config: Record<string, string | undefined>,
    result: ImportServersResult
): void {
    // Check if server already exists
    const existing = readManifest(name);
    if (existing) {
        result.serversSkipped++;
        return;
    }

    const manifest: ServerManifest = {
        name,
        description: `MCP server: ${name}`,
        source: "imported",
        transport: "stdio",
        command: config.command || "",
        args: config.args ? config.args.split(/\s+/).filter(Boolean) : [],
        env: {},
    };

    writeManifest(name, manifest);
    result.serversCreated++;

    // Note: Tools are discovered at runtime by connecting to the MCP server
    // We don't import them statically - the MCP protocol handles discovery
}