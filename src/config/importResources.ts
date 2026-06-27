import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ensureScaffold, resourcePath, sanitize } from "./root";

export interface ImportCount { created: number; skipped: number; }

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Writes a single-file tool/instruction resource if absent (idempotent). */
function writeResource(kind: "tool" | "instruction", name: string, content: string, counts: ImportCount): void {
    if (!sanitize(name)) { return; }
    const file = resourcePath(kind, name);
    if (fs.existsSync(file)) { counts.skipped++; return; }
    fs.writeFileSync(file, content, "utf8");
    counts.created++;
}

function asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------- instructions

/** Known agent-instruction files (project first, then global) → a friendly name. */
function instructionSources(): { file: string; name: string; source: string }[] {
    const home = os.homedir();
    const ws = workspaceRoot();
    const out: { file: string; name: string; source: string }[] = [];
    if (ws) {
        out.push({ file: path.join(ws, ".github", "copilot-instructions.md"), name: "copilot-instructions", source: "Copilot" });
        out.push({ file: path.join(ws, "CLAUDE.md"), name: "claude-project", source: "Claude (project)" });
        out.push({ file: path.join(ws, ".claude", "CLAUDE.md"), name: "claude-project-local", source: "Claude (.claude)" });
        out.push({ file: path.join(ws, "AGENTS.md"), name: "agents", source: "AGENTS.md" });
    }
    out.push({ file: path.join(home, ".claude", "CLAUDE.md"), name: "claude-global", source: "Claude (global)" });
    out.push({ file: path.join(home, ".codex", "AGENTS.md"), name: "codex-agents", source: "Codex" });
    return out;
}

function instructionDef(name: string, source: string, body: string): string {
    const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) || `Imported from ${source}`;
    const description = firstLine.replace(/['"]/g, "").slice(0, 120);
    const fm = [`name: ${name}`, `description: ${description}`, "version: 1"];
    return `---\n${fm.join("\n")}\n---\n\n${body.trim()}\n`;
}

/**
 * Imports existing agent-instruction files into ~/.symposium/repo/instructions:
 *  - Copilot:  <workspace>/.github/copilot-instructions.md
 *  - Claude:   <workspace>/CLAUDE.md, <workspace>/.claude/CLAUDE.md, ~/.claude/CLAUDE.md
 *  - Codex:    <workspace>/AGENTS.md, ~/.codex/AGENTS.md
 * Never overwrites an existing instruction of the same name (idempotent).
 */
export function importInstructions(): ImportCount {
    ensureScaffold();
    const counts: ImportCount = { created: 0, skipped: 0 };
    for (const s of instructionSources()) {
        let body: string;
        try { body = fs.readFileSync(s.file, "utf8"); } catch { continue; }
        if (!body.trim()) { continue; }
        writeResource("instruction", s.name, instructionDef(s.name, s.source, body), counts);
    }
    return counts;
}

// ----------------------------------------------------------------------- tools

interface McpEntry { command?: string; args?: string[]; url?: string; type?: string; credentialRef?: string; }

function mcpToolDef(name: string, e: McpEntry, source: string): string {
    const fm = [`name: ${name}`, `description: MCP tool imported from ${source}.`];
    if (e.command) {
        const cmd = [e.command, ...(e.args ?? [])].join(" ").trim().replace(/'/g, "");
        fm.push("transport: stdio", `command: '${cmd}'`);
    } else {
        fm.push("transport: http", `url: '${(e.url ?? "").replace(/'/g, "")}'`);
    }
    fm.push("capabilities: []", `credentialRef: '${(e.credentialRef ?? "").replace(/'/g, "")}'`, "version: 1");
    return `---\n${fm.join("\n")}\n---\n\n# ${name}\n\nMCP tool imported from ${source}.\n`;
}

/** Minimal reader for Codex's `[mcp_servers.NAME]` TOML sections; [] if absent. */
function readCodexToml(file: string): { name: string; entry: McpEntry }[] {
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
    const servers = new Map<string, McpEntry>();
    let current: string | null = null;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        const header = /^\[mcp_servers\.([^\]]+)\]$/.exec(trimmed);
        if (header) {
            // Sub-tables like `NAME.http_headers` carry an extra dot — skip them.
            current = header[1].includes(".") ? null : header[1];
            if (current && !servers.has(current)) { servers.set(current, {}); }
            continue;
        }
        if (trimmed.startsWith("[")) { current = null; continue; }
        const e = current ? servers.get(current) : undefined;
        if (!e) { continue; }
        const kv = /^([a-zA-Z_]+)\s*=\s*(.+)$/.exec(trimmed);
        if (!kv) { continue; }
        const val = kv[2].trim().replace(/^["']|["']$/g, "");
        if (kv[1] === "command") { e.command = val; }
        else if (kv[1] === "url") { e.url = val; }
        else if (kv[1] === "bearer_token_env_var") { e.credentialRef = val; }
        else if (kv[1] === "args") { e.args = [...kv[2].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]); }
    }
    return [...servers.entries()].map(([name, entry]) => ({ name, entry }));
}

/** Reads {mcpServers|servers} from a JSON config file; [] if absent/invalid. */
function readMcpJson(file: string): { name: string; entry: McpEntry }[] {
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    const obj = asRecord(parsed);
    const servers = asRecord(obj.mcpServers ?? obj.servers);
    const out: { name: string; entry: McpEntry }[] = [];
    for (const [name, raw2] of Object.entries(servers)) {
        const rec = asRecord(raw2);
        out.push({
            name,
            entry: {
                command: typeof rec.command === "string" ? rec.command : undefined,
                args: Array.isArray(rec.args) ? rec.args.map((a) => String(a)) : undefined,
                url: typeof rec.url === "string" ? rec.url : undefined,
                type: typeof rec.type === "string" ? rec.type : undefined,
            },
        });
    }
    return out;
}

/**
 * Imports MCP servers from known CLI configs into ~/.symposium/repo/tools as
 * native tool-defs:
 *  - Claude:  ~/.claude.json, <workspace>/.mcp.json  (mcpServers)
 *  - VS Code: <workspace>/.vscode/mcp.json           (servers)
 * Never overwrites an existing tool of the same name (idempotent).
 */
export function importTools(): ImportCount {
    ensureScaffold();
    const counts: ImportCount = { created: 0, skipped: 0 };
    const home = os.homedir();
    const ws = workspaceRoot();
    const files: { file: string; source: string }[] = [{ file: path.join(home, ".claude.json"), source: "Claude" }];
    if (ws) {
        files.push({ file: path.join(ws, ".mcp.json"), source: "Claude (project)" });
        files.push({ file: path.join(ws, ".vscode", "mcp.json"), source: "VS Code" });
    }
    for (const { file, source } of files) {
        for (const { name, entry } of readMcpJson(file)) {
            writeResource("tool", name, mcpToolDef(name, entry, source), counts);
        }
    }
    // Codex stores MCP servers as TOML (~/.codex/config.toml).
    for (const { name, entry } of readCodexToml(path.join(home, ".codex", "config.toml"))) {
        writeResource("tool", name, mcpToolDef(name, entry, "Codex"), counts);
    }
    return counts;
}
