import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { builtinCommands } from "./builtins";
import { resolveExecutable } from "./exec";
import { contextWindowFor, parseCodexUsage } from "./parse";
import { scrubJsonlLines, scrubSqliteRows } from "./scrub";
import { discoverSlashCommands, findNamedDirs, mergeCommands } from "./skills";
import { parseNativeTodos } from "./todos";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "./types";

export interface CodexAdapterConfig {
    executable: string;
    model: string;
    /** Add the Playwright MCP server (browser navigation tools). */
    playwright?: boolean;
    /** Extra MCP servers ({ name: { command, args } }). */
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

/**
 * Drives the Codex CLI through `codex exec --json` (JSONL events), one
 * process per turn. Continuity uses `codex exec resume <session-id>`; the
 * session id arrives in the `thread.started` event. Sessions are stored as
 * rollout-*.jsonl under ~/.codex/sessions/YYYY/MM/DD.
 */
class CodexSession extends EventEmitter implements AgentSession {
    readonly backend = "codex" as const;
    sessionId: string | undefined;
    private current: ReturnType<typeof spawn> | undefined;
    private disposed = false;
    private reportedError = false;

    constructor(
        private readonly config: CodexAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.sessionId = options.resumeSessionId;
    }

    send(text: string): void {
        const base = ["exec", "--json", "--skip-git-repo-check"];
        const model = this.options.model || this.config.model;
        if (model) {
            base.push("--model", model);
        }
        if (this.options.reasoning && this.options.reasoning !== "default") {
            base.push("-c", `model_reasoning_effort="${this.options.reasoning}"`);
        }
        // MCP servers (Playwright browser tools + extras) as `-c` TOML overrides.
        const servers: Record<string, { command?: string; args?: string[] }> = { ...(this.config.mcpServers ?? {}) };
        if (this.config.playwright && !servers.playwright) {
            servers.playwright = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
        }
        for (const [name, s] of Object.entries(servers)) {
            if (s.command) { base.push("-c", `mcp_servers.${name}.command=${JSON.stringify(s.command)}`); }
            if (s.args) { base.push("-c", `mcp_servers.${name}.args=${JSON.stringify(s.args)}`); }
        }
        // `resume <id>` must precede the prompt; a fresh turn just passes the prompt.
        const args = this.sessionId
            ? [...base, "resume", this.sessionId, text]
            : [...base, text];

        const child = spawn(resolveExecutable(this.config.executable), args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.options.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.current = child;
        this.reportedError = false;

        const rl = readline.createInterface({ input: child.stdout! });
        rl.on("line", (line) => this.handleLine(line));

        let stderr = "";
        child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) => {
            this.emit("event", { kind: "error", message: `codex spawn failed: ${error.message}` });
            this.emit("event", { kind: "turn-end" });
        });
        child.on("exit", (code) => {
            this.current = undefined;
            if (this.disposed) {
                return;
            }
            if (code !== 0 && code !== null && !this.reportedError) {
                const detail = stderr.trim().split("\n").slice(-2).join(" ");
                this.emit("event", { kind: "error", message: `codex exited with code ${code}: ${detail}` });
            }
            this.emit("event", { kind: "turn-end" });
        });
    }

    private handleLine(line: string): void {
        if (!line.trim()) {
            return;
        }
        let event: any;
        try {
            event = JSON.parse(line);
        } catch {
            return; // non-JSON log lines (codex prints some ERROR lines plainly)
        }
        switch (event.type) {
            case "thread.started":
                if (event.thread_id && !this.sessionId) {
                    this.sessionId = event.thread_id;
                    this.emit("event", { kind: "session", sessionId: event.thread_id });
                }
                break;
            case "item.started":
            case "item.completed": {
                const item = event.item ?? {};
                const itemType = item.type ?? item.item_type;
                // Codex's plan/todo updates (e.g. update_plan / todo_list).
                const todos = parseNativeTodos(String(itemType ?? ""), item);
                if (todos) {
                    this.emit("event", { kind: "tool-start", toolName: "TodoWrite", detail: "", todos });
                    break;
                }
                if (event.type !== "item.completed") {
                    if (itemType === "command_execution" && item.command) {
                        this.emit("event", { kind: "tool-start", toolName: "exec", detail: String(item.command).slice(0, 120) });
                    }
                    break;
                }
                if (itemType === "agent_message" && item.text) {
                    this.emit("event", { kind: "text", text: item.text });
                } else if (itemType === "reasoning" && item.text) {
                    this.emit("event", { kind: "text", text: item.text });
                } else if (itemType === "command_execution") {
                    this.emit("event", { kind: "tool-end", toolName: "exec", detail: item.command });
                } else if (itemType === "file_change" || itemType === "mcp_tool_call" || itemType === "web_search") {
                    this.emit("event", { kind: "tool-end", toolName: itemType });
                }
                break;
            }
            case "token_count":
                // Streamed during a turn (event_msg/token_count). Carries the
                // richest usage incl. model_context_window — surface it live so
                // the Context Window meter fills before the turn even ends.
                this.emitUsage(event);
                break;
            case "turn.completed":
                // turn.completed may carry { usage: {...} }. Emit usage (if any)
                // BEFORE turn-end so the meter reflects the final totals.
                this.emitUsage(event);
                this.emit("event", { kind: "turn-end" });
                break;
            case "turn.failed":
                this.reportedError = true;
                this.emit("event", { kind: "error", message: event.error?.message ?? "codex turn failed" });
                this.emit("event", { kind: "turn-end" });
                break;
            case "error": {
                const message = event.message ?? "codex error";
                // "Reconnecting... N/5" are transient retry notices, not failures;
                // the terminal error (or turn.failed) is surfaced separately.
                if (/^Reconnecting\.\.\./.test(message)) {
                    break;
                }
                this.reportedError = true;
                this.emit("event", { kind: "error", message });
                break;
            }
        }
    }

    /**
     * Normalize a Codex usage-bearing event and emit a `usage` UI event. Falls
     * back to the configured model's context window when Codex doesn't report
     * one (older exec streams omit model_context_window).
     */
    private emitUsage(event: unknown): void {
        const u = parseCodexUsage(event);
        if (!u) { return; }
        this.emit("event", {
            kind: "usage",
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheRead: u.cacheRead,
            contextWindow: u.contextWindow ?? contextWindowFor(this.options.model || this.config.model),
        });
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

/**
 * Codex sessions begin with injected scaffolding (AGENTS.md, IDE context,
 * environment tags) before the real prompt. These are wrapped in tags or
 * markdown headers, so skip `<...>` blocks and `# `-headed context for
 * titles and history.
 */
function looksInjected(text: string): boolean {
    return text.startsWith("<") || text.startsWith("# ");
}

export class CodexAdapter implements AgentAdapter {
    readonly backend = "codex" as const;

    constructor(private readonly getConfig: () => CodexAdapterConfig) { }

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

    /** Walks ~/.codex/sessions/YYYY/MM/DD for rollout-*.jsonl files. */
    async listSessions(): Promise<SessionInfo[]> {
        const root = path.join(os.homedir(), ".codex", "sessions");
        const files: string[] = [];
        const walk = async (dir: string, depth: number): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory() && depth < 3) {
                    await walk(full, depth + 1);
                } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
                    files.push(full);
                }
            }
        };
        await walk(root, 0);

        const sessions: SessionInfo[] = [];
        for (const file of files) {
            try {
                const meta = await readCodexMeta(file);
                if (!meta.id) {
                    continue;
                }
                const stat = await fs.promises.stat(file);
                sessions.push({
                    backend: "codex",
                    sessionId: meta.id,
                    title: meta.title ?? path.basename(file),
                    cwd: meta.cwd,
                    updatedAt: stat.mtime,
                    transcriptPath: file,
                });
            } catch {
                // skip unreadable rollout files
            }
        }
        sessions.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
        return sessions.slice(0, 50);
    }

    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        const file = info.transcriptPath;
        if (!file) {
            return [];
        }
        let content: string;
        try {
            content = await fs.promises.readFile(file, "utf8");
        } catch {
            return [];
        }
        const messages: HistoryMessage[] = [];
        for (const line of content.split("\n")) {
            if (!line.trim()) {
                continue;
            }
            let entry: any;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            if (entry.type !== "response_item" || entry.payload?.type !== "message") {
                continue;
            }
            const role = entry.payload.role;
            if (role !== "user" && role !== "assistant") {
                continue; // skip developer/system scaffolding
            }
            const text = (entry.payload.content ?? [])
                .filter((c: any) => c.type === "input_text" || c.type === "output_text" || c.type === "text")
                .map((c: any) => c.text)
                .join("")
                .trim();
            // Skip the large injected scaffolding messages (instructions, skills, etc.).
            if (text && !looksInjected(text)) {
                messages.push({ role: role === "user" ? "user" : "assistant", text });
            }
        }
        return messages;
    }

    start(options: SessionStartOptions): AgentSession {
        return new CodexSession(this.getConfig(), options);
    }

    models(): string[] {
        const configured = this.getConfig().model;
        const known = ["gpt-5.2-codex", "gpt-5.2", "o4-mini"];
        return [...new Set([configured || "default", ...known])];
    }

    hasNativeTodo(): boolean { return true; }   // update_plan / todo_list

    // codex -c model_reasoning_effort="<level>" (0.139.0). "default" = omit.
    reasoningLevels(): string[] {
        return ["default", "minimal", "low", "medium", "high"];
    }

    /**
     * Permanently scrubs every on-disk trace of a session from Codex:
     *   - sessions/.../rollout-*-<id>.jsonl  (transcript)
     *   - session_index.jsonl                (line with "id":"<id>")
     *   - history.jsonl                       (entries for the session)
     * Returns the names of stores that may still hold residual data so the
     * caller can warn the user (e.g. the aggregate logs_*.sqlite).
     */
    async commands(): Promise<SlashCommand[]> {
        const root = path.join(os.homedir(), ".codex");
        const pluginSkills = await findNamedDirs(path.join(root, "plugins"), "skills");
        const discovered = await discoverSlashCommands(
            // Codex's bundled skills live under skills/.system/<name>/SKILL.md.
            [path.join(root, "skills"), path.join(root, "skills", ".system"), ...pluginSkills],
            [path.join(root, "prompts")],
        );
        const version = (await this.available()).version;
        return mergeCommands(builtinCommands("codex", version), discovered);
    }

    async deleteSession(info: SessionInfo): Promise<string[]> {
        const root = path.join(os.homedir(), ".codex");
        const id = info.sessionId;
        if (info.transcriptPath) {
            await fs.promises.rm(info.transcriptPath, { force: true });
        }
        await scrubJsonlLines(path.join(root, "session_index.jsonl"),
            (entry) => entry?.id === id || entry?.session_id === id || entry?.thread_id === id);
        await scrubJsonlLines(path.join(root, "history.jsonl"),
            (entry) => entry?.session_id === id || entry?.id === id);

        // Codex also writes an aggregate sqlite log keyed by thread_id (= the
        // session GUID). Delete those rows and VACUUM so nothing lingers in
        // free pages; only report residual if no sqlite tool was available.
        const residual: string[] = [];
        let dbFiles: string[] = [];
        try {
            dbFiles = (await fs.promises.readdir(root)).filter((f) => /^logs.*\.sqlite$/.test(f));
        } catch {
            // ignore
        }
        for (const dbFile of dbFiles) {
            const scrubbed = await scrubSqliteRows(path.join(root, dbFile), "logs", "thread_id", id);
            if (!scrubbed) {
                residual.push(`~/.codex/${dbFile} (install python3 or sqlite3 to scrub)`);
            }
        }
        return residual;
    }
}

/** Reads the session_meta line (id, cwd) and first real user prompt (title). */
async function readCodexMeta(file: string): Promise<{ id?: string; cwd?: string; title?: string }> {
    let content: string;
    try {
        content = await fs.promises.readFile(file, "utf8");
    } catch {
        return {};
    }
    let id: string | undefined;
    let cwd: string | undefined;
    let title: string | undefined;
    for (const line of content.split("\n").slice(0, 60)) {
        if (!line.trim()) {
            continue;
        }
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry.type === "session_meta") {
            id = entry.payload?.id;
            cwd = entry.payload?.cwd;
        } else if (!title && entry.type === "response_item" && entry.payload?.type === "message" && entry.payload.role === "user") {
            const text = (entry.payload.content ?? [])
                .filter((c: any) => c.type === "input_text" || c.type === "text")
                .map((c: any) => c.text)
                .join("")
                .trim();
            if (text && !looksInjected(text)) {
                title = text.slice(0, 80);
            }
        }
        if (id && title) {
            break;
        }
    }
    return { id, cwd, title };
}
