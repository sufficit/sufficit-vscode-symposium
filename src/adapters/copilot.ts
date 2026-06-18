import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { builtinCommands } from "./builtins";
import { resolveExecutable } from "./exec";
import { discoverSlashCommands, findNamedDirs, mergeCommands } from "./skills";
import { TODO_INJECTION } from "./todos";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "./types";

export interface CopilotAdapterConfig {
    executable: string;
    model: string;
    /** Add the Playwright MCP server (browser navigation tools). */
    playwright?: boolean;
    /** Extra MCP servers ({ name: { command, args } }). */
    mcpServers?: Record<string, unknown>;
}

/** Writes a shared MCP config (Playwright + extras) and returns its path, or undefined. */
function buildMcpConfigFile(cfg: { playwright?: boolean; mcpServers?: Record<string, unknown> }, name: string): string | undefined {
    const servers: Record<string, unknown> = { ...(cfg.mcpServers ?? {}) };
    if (cfg.playwright && !servers.playwright) {
        servers.playwright = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
    }
    if (Object.keys(servers).length === 0) { return undefined; }
    try {
        const dir = path.join(os.homedir(), ".symposium");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
        return file;
    } catch { return undefined; }
}


function candidateWorkspaceStorageRoots(): string[] {
    const h = os.homedir();
    return [
        path.join(h, ".config", "Code", "User", "workspaceStorage"),
        path.join(h, ".local", "share", "code-server", "User", "workspaceStorage"),
    ];
}

function walkJsonl(dir: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { out.push(...walkJsonl(p)); }
        else if (e.isFile() && e.name.endsWith(".jsonl")) { out.push(p); }
    }
    return out;
}

function copilotTranscriptFiles(): string[] {
    const files: string[] = [];
    for (const root of candidateWorkspaceStorageRoots()) {
        let workspaces: fs.Dirent[];
        try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const ws of workspaces) {
            if (!ws.isDirectory()) { continue; }
            const transcriptDir = path.join(root, ws.name, "GitHub.copilot-chat", "transcripts");
            files.push(...walkJsonl(transcriptDir));
        }
    }
    return [...new Set(files)];
}

function parseTimestamp(value: unknown): number | undefined {
    if (typeof value === "number") { return value; }
    if (typeof value === "string") {
        const t = Date.parse(value);
        return Number.isFinite(t) ? t : undefined;
    }
    return undefined;
}

function chatSessionTitle(file: string): string | undefined {
    try {
        let inputText = "";
        let lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) { continue; }
            let j: any;
            try { j = JSON.parse(line); } catch { continue; }
            // kind 0 = session snapshot: inputState.inputText may or may not be set.
            if (j && j.kind === 0 && j.v) {
                const t = typeof j.v.inputState?.inputText === "string" ? j.v.inputState.inputText.trim() : "";
                if (t) { inputText = t; }
            }
            // kind 1 = incremental delta; text updates via ["inputState","inputText"] key.
            if (j && j.kind === 1 && Array.isArray(j.k)) {
                if (j.k.length === 2 && j.k[0] === "inputState" && (j.k[1] === "inputText" || j.k[1] === "value")) {
                    const v = typeof j.v === "string" ? j.v.trim() : "";
                    // Some code-server versions store a placeholder hash instead of real text on empty state.
                    if (v && v.length < 200 && /^[a-f0-9]+$/i.test(v)) { continue; }
                    if (v) { inputText = v; }
                }
            }
        }
        return inputText ? inputText.slice(0, 80) : undefined;
    } catch { return undefined; }
}

function allCopilotSessions(): Map<string, { label: string; updatedTs: number; isTranscript: boolean }> {
    const map = new Map<string, { label: string; updatedTs: number; isTranscript: boolean }>();
    // Transcripts (full content, preferred)
    for (const file of copilotTranscriptFiles()) {
        const id = path.basename(file, ".jsonl");
        const info = transcriptSummary(file);
        if (info) {
            const existing = map.get(id);
            map.set(id, { label: info.title, updatedTs: info.updatedAt ? info.updatedAt.getTime() : 0, isTranscript: true });
        }
    }
    // chatSessions metadata (no-transcript sessions, fallback)
    for (const file of chatSessionsFiles()) {
        const id = path.basename(file, ".jsonl");
        if (map.has(id)) { continue; }  // transcripted session wins
        const label = chatSessionTitle(file);
        if (!label) { continue; }
        let updatedTs = 0;
        try {
            const stat = fs.statSync(file);
            updatedTs = stat.mtimeMs;
        } catch { /* ignore */ }
        map.set(id, { label, updatedTs, isTranscript: false });
    }
    return map;
}

function chatSessionsFiles(): string[] {
    const files: string[] = [];
    for (const root of candidateWorkspaceStorageRoots()) {
        let workspaces: fs.Dirent[];
        try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const ws of workspaces) {
            if (!ws.isDirectory()) { continue; }
            const dir = path.join(root, ws.name, "chatSessions");
            files.push(...walkJsonl(dir));
        }
    }
    return [...new Set(files)];
}

function transcriptSummary(file: string): SessionInfo | undefined {
    const sessionId = path.basename(file, ".jsonl");
    let title = "Copilot Chat";
    let firstUser = "";
    let updated = 0;
    try {
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) { continue; }
            let ev: any;
            try { ev = JSON.parse(line); } catch { continue; }
            const ts = parseTimestamp(ev.timestamp);
            if (ts && ts > updated) { updated = ts; }
            if (!firstUser && ev.type === "user.message") {
                const c = ev.data?.content;
                if (typeof c !== "string" || !c.trim()) { continue; }
                const clean = c.trim();
                // VS Code auto-summaries wrap the real prompt between tags.
                const summaryMatch = clean.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
                firstUser = summaryMatch ? summaryMatch[1].trim() : clean;
                title = firstUser.slice(0, 80);
            }
        }
        // No user.message found in transcript: try the chatSessions metadata.
        if (!firstUser) {
            for (const root of candidateWorkspaceStorageRoots()) {
                let workspaces: fs.Dirent[];
                try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
                for (const ws of workspaces) {
                    if (!ws.isDirectory()) { continue; }
                    const chatFile = path.join(root, ws.name, "chatSessions", sessionId + ".jsonl");
                    const cs = chatSessionTitle(chatFile);
                    if (cs) { title = cs; break; }
                }
                if (title !== "Copilot Chat") { break; }
            }
        }
    } catch { return undefined; }
    return {
        backend: "copilot",
        sessionId,
        title,
        updatedAt: updated ? new Date(updated) : undefined,
        transcriptPath: file,
    };
}

function parseToolArgs(raw: unknown): string | undefined {
    if (typeof raw !== "string" || !raw.trim()) { return undefined; }
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function toolDetail(name: string, args: string | undefined): string {
    if (!args) { return name; }
    try {
        const o = JSON.parse(args);
        return String(o.explanation || o.description || o.goal || o.command || o.filePath || o.path || o.query || name).slice(0, 160);
    } catch { return name; }
}

function transcriptHistory(file: string): HistoryMessage[] {
    const out: HistoryMessage[] = [];
    try {
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
            if (!line.trim()) { continue; }
            let ev: any;
            try { ev = JSON.parse(line); } catch { continue; }
            const ts = parseTimestamp(ev.timestamp);
            if (ev.type === "user.message") {
                const content = ev.data?.content;
                if (typeof content === "string" && content.trim()) { out.push({ role: "user", text: content, ts }); }
                continue;
            }
            if (ev.type === "assistant.message") {
                const content = ev.data?.content;
                if (typeof content === "string" && content.trim()) { out.push({ role: "assistant", text: content, ts }); }
                for (const t of ev.data?.toolRequests ?? []) {
                    const name = String(t.name || "tool");
                    const input = parseToolArgs(t.arguments);
                    out.push({ role: "tool", text: name, toolName: name, detail: toolDetail(name, input), input, ts });
                }
                continue;
            }
        }
    } catch { /* ignore */ }
    return out;
}

function rmrf(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function deleteImportedCopilotSession(info: SessionInfo): string[] {
    const residual: string[] = [];
    const files = info.transcriptPath
        ? [info.transcriptPath]
        : copilotTranscriptFiles().filter((p) => path.basename(p, ".jsonl") === info.sessionId);
    for (const transcript of files) {
        rmrf(transcript);
        const wsRoot = transcript.split(`${path.sep}GitHub.copilot-chat${path.sep}`)[0];
        if (!wsRoot || wsRoot === transcript) { continue; }
        rmrf(path.join(wsRoot, "GitHub.copilot-chat", "debug-logs", info.sessionId));
        rmrf(path.join(wsRoot, "GitHub.copilot-chat", "chat-session-resources", info.sessionId));
        rmrf(path.join(wsRoot, "chatSessions", info.sessionId + ".jsonl"));
    }
    // Also remove any matching chatSessions file by id.
    for (const root of candidateWorkspaceStorageRoots()) {
        let workspaces: fs.Dirent[];
        try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const ws of workspaces) {
            if (!ws.isDirectory()) { continue; }
            rmrf(path.join(root, ws.name, "chatSessions", info.sessionId + ".jsonl"));
        }
    }
    if (!files.length) {
        residual.push("Copilot transcript not found; removed matching chatSessions entries only");
    }
    return residual;
}

/**
 * Drives the GitHub Copilot CLI in non-interactive JSONL mode:
 * `copilot -p <text> --output-format json`, one process per turn,
 * continuity via `--resume <session-id>` (the final "result" event
 * carries the session id). The native `--acp` server is the planned
 * upgrade path for persistent bidirectional sessions.
 */
class CopilotSession extends EventEmitter implements AgentSession {
    readonly backend = "copilot" as const;
    sessionId: string | undefined;
    private current: ReturnType<typeof spawn> | undefined;
    private disposed = false;

    constructor(
        private readonly config: CopilotAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.sessionId = options.resumeSessionId;
    }

    send(text: string): void {
        const args = ["-p", text, "--output-format", "json"];
        const model = this.options.model || this.config.model;
        if (model) {
            args.push("--model", model);
        }
        if (this.options.reasoning && this.options.reasoning !== "default") {
            args.push("--reasoning-effort", this.options.reasoning);
        }
        if (this.sessionId) {
            args.push("--resume", this.sessionId);
        }
        const mcp = buildMcpConfigFile(this.config, "copilot-mcp.json");
        if (mcp) { args.push("--mcp-config", mcp); }
        const child = spawn(resolveExecutable(this.config.executable), args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.options.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.current = child;

        const rl = readline.createInterface({ input: child.stdout! });
        rl.on("line", (line) => this.handleLine(line));

        let stderr = "";
        child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) => {
            this.emit("event", { kind: "error", message: `copilot spawn failed: ${error.message}` });
            this.emit("event", { kind: "turn-end" });
        });
        child.on("exit", (code) => {
            this.current = undefined;
            if (this.disposed) {
                return;
            }
            if (code !== 0 && code !== null && !this.reportedError) {
                const detail = stderr.trim().split("\n").slice(-2).join(" ");
                this.emit("event", { kind: "error", message: `copilot exited with code ${code}: ${detail}` });
            }
            this.emit("event", { kind: "turn-end" });
        });
    }

    private reportedError = false;

    private handleLine(line: string): void {
        if (!line.trim()) {
            return;
        }
        let event: any;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        switch (event.type) {
            case "assistant.message": {
                const content = event.data?.content;
                if (typeof content === "string" && content) {
                    this.emit("event", { kind: "text", text: content });
                }
                for (const tool of event.data?.toolRequests ?? []) {
                    this.emit("event", { kind: "tool-start", toolName: tool.name ?? "tool" });
                }
                break;
            }
            case "tool.execution_start":
                this.emit("event", {
                    kind: "tool-start",
                    toolName: event.data?.toolName ?? "tool",
                });
                break;
            case "tool.execution_end":
                this.emit("event", { kind: "tool-end", toolName: event.data?.toolName ?? "tool" });
                break;
            case "session.error":
                this.reportedError = true;
                this.emit("event", { kind: "error", message: event.data?.message ?? "unknown copilot error" });
                break;
            case "result":
                if (event.sessionId && !this.sessionId) {
                    this.sessionId = event.sessionId;
                    this.emit("event", { kind: "session", sessionId: event.sessionId });
                }
                break;
        }
    }

    cancel(): void {
        this.current?.kill("SIGINT");
    }

    dispose(): void {
        this.disposed = true;
        this.current?.kill();
        this.current = undefined;
        this.removeAllListeners();
    }
}

export class CopilotAdapter implements AgentAdapter {
    readonly backend = "copilot" as const;

    constructor(private readonly getConfig: () => CopilotAdapterConfig) { }

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        return new Promise((resolve) => {
            const child = spawn(resolveExecutable(this.getConfig().executable), ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
            let out = "";
            child.stdout.on("data", (chunk) => { out += String(chunk); });
            child.on("error", (error) => resolve({ ok: false, error: error.message }));
            child.on("exit", (code) =>
                code === 0
                    ? resolve({ ok: true, version: out.trim().split("\n")[0] })
                    : resolve({ ok: false, error: `exit code ${code}` }));
        });
    }

    /**
     * Copilot CLI itself does not expose a list command, but VS Code Copilot
     * Chat stores transcripts in workspaceStorage/GitHub.copilot-chat. Import
     * those as read/history sessions so Symposium's list matches the native
     * Copilot Chat sessions view (including code-server).
     */
    async listSessions(): Promise<SessionInfo[]> {
        const all = allCopilotSessions();
        const out: SessionInfo[] = [];
        for (const [id, e] of all) {
            out.push({
                backend: "copilot" as const,
                sessionId: id,
                title: e.label,
                updatedAt: e.updatedTs ? new Date(e.updatedTs) : undefined,
                transcriptPath: e.isTranscript ? copilotTranscriptFiles().find((f) => path.basename(f, ".jsonl") === id) : undefined,
            });
        }
        return out.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    }

    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        const file = info.transcriptPath ?? copilotTranscriptFiles().find((p) => path.basename(p, ".jsonl") === info.sessionId);
        return file ? transcriptHistory(file) : [];
    }

    async deleteSession(info: SessionInfo): Promise<string[] | void> {
        return deleteImportedCopilotSession(info);
    }

    start(options: SessionStartOptions): AgentSession {
        return new CopilotSession(this.getConfig(), options);
    }

    models(): string[] {
        const configured = this.getConfig().model;
        const known = ["auto", "claude-sonnet-4.6", "claude-haiku-4.5", "gpt-5.2", "gpt-5-mini"];
        return [...new Set([configured || "auto", ...known])];
    }

    // No native plan/todo tool: Symposium injects one and parses a ```todo block.
    hasNativeTodo(): boolean { return false; }
    todoInjection(): string { return TODO_INJECTION; }

    // copilot --reasoning-effort <level> (1.0.61). "default" = omit.
    reasoningLevels(): string[] {
        return ["default", "low", "medium", "high", "xhigh"];
    }

    async commands(): Promise<SlashCommand[]> {
        const root = path.join(os.homedir(), ".copilot");
        const pluginSkills = await findNamedDirs(path.join(root, "plugins"), "skills");
        const discovered = await discoverSlashCommands(
            [path.join(root, "skills"), ...pluginSkills],
            [path.join(root, "prompts"), path.join(root, "commands")],
        );
        const version = (await this.available()).version;
        return mergeCommands(builtinCommands("copilot", version), discovered);
    }
}
