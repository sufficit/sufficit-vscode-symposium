import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { builtinCommands } from "./builtins";
import { resolveExecutable } from "./exec";
import { removeMatchingFiles, scrubJsonlLines } from "./scrub";
import { discoverSlashCommands, findNamedDirs, mergeCommands } from "./skills";
import {
    AgentAdapter,
    AgentSession,
    FollowHandle,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
    TodoItem,
} from "./types";

export interface ClaudeAdapterConfig {
    executable: string;
    /** Optional diagnostics sink (the Symposium output channel). */
    log?: (message: string) => void;
    model: string;
    permissionMode: string;
    env: Record<string, string>;
}

/**
 * Drives the Claude Code CLI through its bidirectional JSONL protocol:
 * `claude -p --input-format stream-json --output-format stream-json`.
 *
 * One child process per session; user messages are written to stdin as
 * {"type":"user",...} lines and events are parsed from stdout lines.
 */
class ClaudeSession extends EventEmitter implements AgentSession {
    readonly backend = "claude" as const;
    sessionId: string | undefined;
    private child: ChildProcessWithoutNullStreams | undefined;
    private disposed = false;

    constructor(
        private readonly config: ClaudeAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.options.resumeSessionId && (this.sessionId = this.options.resumeSessionId);
    }

    private ensureStarted(): ChildProcessWithoutNullStreams {
        if (this.child) {
            return this.child;
        }
        const args = [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
        ];
        const model = this.options.model || this.config.model;
        if (model) {
            args.push("--model", model);
        }
        if (this.options.reasoning && this.options.reasoning !== "default") {
            args.push("--effort", this.options.reasoning);
        }
        const permission = this.options.permission || this.config.permissionMode;
        if (permission && permission !== "default") {
            args.push("--permission-mode", permission);
        }
        if (this.options.resumeSessionId) {
            args.push("--resume", this.options.resumeSessionId);
        }
        const executable = resolveExecutable(this.config.executable);
        this.config.log?.(`[claude] spawn ${executable} ${args.join(" ")} (cwd=${this.options.cwd})`);
        const child = spawn(executable, args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.config.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;

        const rl = readline.createInterface({ input: child.stdout });
        rl.on("line", (line) => this.handleLine(line));

        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) => {
            this.config.log?.(`[claude] spawn error: ${error.message}`);
            this.emit("event", { kind: "error", message: `claude spawn failed (${executable}): ${error.message}` });
            this.emit("event", { kind: "turn-end" });
        });
        child.on("exit", (code) => {
            if (!this.disposed && code !== 0 && code !== null) {
                const detail = stderr.trim().split("\n").slice(-3).join(" ");
                this.emit("event", { kind: "error", message: `claude exited with code ${code}: ${detail}` });
            }
            this.child = undefined;
        });
        return child;
    }

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
            case "system":
                if (event.subtype === "init") {
                    this.sessionId = event.session_id;
                    this.emit("event", { kind: "session", sessionId: event.session_id, model: event.model });
                }
                break;
            case "assistant": {
                for (const block of event.message?.content ?? []) {
                    if (block.type === "text" && block.text) {
                        this.emit("event", { kind: "text", text: block.text });
                    } else if (block.type === "tool_use") {
                        const counts = diffCounts(block.name, block.input);
                        this.emit("event", {
                            kind: "tool-start",
                            toolName: block.name,
                            detail: summarizeToolInput(block.input),
                            toolId: block.id,
                            input: prettyJson(block.input),
                            added: counts?.added,
                            removed: counts?.removed,
                            todos: extractTodos(block.name, block.input),
                            path: counts ? (block.input as any)?.file_path : undefined,
                        });
                    }
                }
                break;
            }
            case "user": {
                for (const block of event.message?.content ?? []) {
                    if (block.type === "tool_result") {
                        this.emit("event", {
                            kind: "tool-end",
                            toolName: block.tool_use_id ?? "tool",
                            toolId: block.tool_use_id,
                            result: toolResultText(block.content),
                        });
                    }
                }
                break;
            }
            case "result":
                this.sessionId = event.session_id ?? this.sessionId;
                if (event.is_error) {
                    this.emit("event", { kind: "error", message: event.result ?? event.subtype ?? "unknown error" });
                }
                this.emit("event", {
                    kind: "turn-end",
                    costUsd: event.total_cost_usd,
                    durationMs: event.duration_ms,
                });
                break;
        }
    }

    send(text: string): void {
        const child = this.ensureStarted();
        const message = {
            type: "user",
            message: { role: "user", content: [{ type: "text", text }] },
        };
        child.stdin.write(JSON.stringify(message) + "\n");
    }

    cancel(): void {
        this.child?.kill("SIGINT");
    }

    dispose(): void {
        this.disposed = true;
        this.child?.kill();
        this.child = undefined;
        this.removeAllListeners();
    }
}

/**
 * A short, human target for a tool call — the file, command, pattern or url —
 * so the UI can show "Read foo.ts" / "Ran npm test" like the native chat,
 * instead of a raw JSON blob.
 */
function summarizeToolInput(input: unknown): string {
    const o = (input ?? {}) as Record<string, unknown>;
    // Keep the last two path segments for context (e.g. "ui/chatHtml.ts")
    // without dumping a long absolute path.
    const short = (p: unknown) => {
        const parts = String(p).split("/").filter(Boolean);
        return parts.slice(-2).join("/") || String(p);
    };
    const filePath = typeof o.file_path === "string" ? o.file_path
        : typeof o.notebook_path === "string" ? o.notebook_path
            : typeof o.path === "string" ? o.path : undefined;
    let s = "";
    if (filePath) {
        s = short(filePath);
        // Read with a line window: show the range so it's clear what was read.
        if (typeof o.offset === "number") {
            const end = typeof o.limit === "number" ? o.offset + o.limit : undefined;
            s += ":" + o.offset + (end ? "-" + end : "");
        }
    }
    else if (typeof o.command === "string") { s = o.command.trim().replace(/\s+/g, " "); }
    else if (typeof o.pattern === "string") { s = '"' + o.pattern + '"' + (typeof o.path === "string" ? " in " + short(o.path) : ""); }
    else if (typeof o.url === "string") { s = o.url; }
    else if (typeof o.query === "string") { s = o.query; }
    else if (typeof o.description === "string") { s = o.description; }
    else if (typeof o.prompt === "string") { s = o.prompt; }
    else {
        const first = Object.values(o).find((v) => typeof v === "string") as string | undefined;
        s = first ?? "";
    }
    return s.length > 160 ? s.slice(0, 157) + "..." : s;
}

/** Line count of a string block (0 for empty/missing). */
function lineCount(s: unknown): number {
    return typeof s === "string" && s.length ? s.split("\n").length : 0;
}

/**
 * Approximate added/removed line counts for a write/edit tool, so the row can
 * show +N/-M like the native chat. Edit: new vs old string; MultiEdit: summed;
 * Write: whole content added.
 */
function diffCounts(name: string, input: unknown): { added: number; removed: number } | undefined {
    const o = (input ?? {}) as Record<string, unknown>;
    if (name === "Write") {
        return { added: lineCount(o.content), removed: 0 };
    }
    if (name === "Edit") {
        return { added: lineCount(o.new_string), removed: lineCount(o.old_string) };
    }
    if (name === "MultiEdit" && Array.isArray(o.edits)) {
        let added = 0, removed = 0;
        for (const e of o.edits as any[]) { added += lineCount(e?.new_string); removed += lineCount(e?.old_string); }
        return { added, removed };
    }
    return undefined;
}

/** Extract a TodoWrite plan list, if this tool carries one. */
function extractTodos(name: string, input: unknown): TodoItem[] | undefined {
    if (name !== "TodoWrite") { return undefined; }
    const todos = (input as any)?.todos;
    if (!Array.isArray(todos)) { return undefined; }
    return todos.map((t: any) => ({
        content: String(t?.content ?? ""),
        status: t?.status === "completed" || t?.status === "in_progress" ? t.status : "pending",
    }));
}

/** Pretty-print a tool input for the expandable panel (capped). */
function prettyJson(input: unknown): string {
    try {
        const s = JSON.stringify(input, null, 2);
        return s.length > 6000 ? s.slice(0, 6000) + "\n…(truncated)" : s;
    } catch {
        return String(input ?? "");
    }
}

/** Flatten a tool_result content (string or content blocks) to text (capped). */
function toolResultText(content: unknown): string {
    let s: string;
    if (typeof content === "string") {
        s = content;
    } else if (Array.isArray(content)) {
        s = content.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("");
    } else {
        try { s = JSON.stringify(content); } catch { s = String(content ?? ""); }
    }
    return s.length > 6000 ? s.slice(0, 6000) + "\n…(truncated)" : s;
}

export class ClaudeAdapter implements AgentAdapter {
    readonly backend = "claude" as const;

    constructor(private readonly getConfig: () => ClaudeAdapterConfig) { }

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        return new Promise((resolve) => {
            const child = spawn(resolveExecutable(this.getConfig().executable), ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
            let out = "";
            child.stdout.on("data", (chunk) => { out += String(chunk); });
            child.on("error", (error) => resolve({ ok: false, error: error.message }));
            child.on("exit", (code) =>
                code === 0
                    ? resolve({ ok: true, version: out.trim() })
                    : resolve({ ok: false, error: `exit code ${code}` }));
        });
    }

    /**
     * Claude Code stores transcripts under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
     * where the cwd path separators are replaced by dashes.
     */
    async listSessions(): Promise<SessionInfo[]> {
        const root = path.join(os.homedir(), ".claude", "projects");
        const sessions: SessionInfo[] = [];
        let projectDirs: string[];
        try {
            projectDirs = await fs.promises.readdir(root);
        } catch {
            return sessions;
        }
        for (const dir of projectDirs) {
            const projectPath = path.join(root, dir);
            let files: string[];
            try {
                files = await fs.promises.readdir(projectPath);
            } catch {
                continue;
            }
            for (const file of files) {
                if (!file.endsWith(".jsonl")) {
                    continue;
                }
                const fullPath = path.join(projectPath, file);
                try {
                    const stat = await fs.promises.stat(fullPath);
                    const meta = await readSessionMeta(fullPath);
                    sessions.push({
                        backend: "claude",
                        sessionId: path.basename(file, ".jsonl"),
                        title: meta.title ?? dir,
                        cwd: meta.cwd,
                        updatedAt: stat.mtime,
                        transcriptPath: fullPath,
                    });
                } catch {
                    // unreadable session files are skipped
                }
            }
        }
        sessions.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
        return sessions.slice(0, 50);
    }

    start(options: SessionStartOptions): AgentSession {
        return new ClaudeSession(this.getConfig(), options);
    }

    models(): string[] {
        const configured = this.getConfig().model;
        const known = ["sonnet", "opus", "haiku"];
        return [...new Set([configured || "default", ...known])];
    }

    // claude --effort <level> (2.1.177). "default" means: don't pass the flag.
    reasoningLevels(): string[] {
        return ["default", "low", "medium", "high", "xhigh", "max"];
    }

    permissionModes(): string[] {
        return ["default", "acceptEdits", "bypassPermissions", "plan"];
    }

    defaultPermission(): string {
        return this.getConfig().permissionMode || "default";
    }

    async commands(): Promise<SlashCommand[]> {
        const root = path.join(os.homedir(), ".claude");
        const marketplaces = path.join(root, "plugins", "marketplaces");
        const pluginSkills = await findNamedDirs(marketplaces, "skills");
        const pluginCommands = await findNamedDirs(marketplaces, "commands");
        const discovered = await discoverSlashCommands(
            [path.join(root, "skills"), ...pluginSkills],
            [path.join(root, "commands"), ...pluginCommands],
        );
        const version = (await this.available()).version;
        return mergeCommands(builtinCommands("claude", version, this.getConfig().log), discovered);
    }

    /**
     * Permanently scrubs every on-disk trace of a session from Claude Code,
     * not just the transcript — so a deleted session leaves no recoverable
     * data behind:
     *   - projects/<cwd>/<id>.jsonl   (transcript)
     *   - history.jsonl                (lines with "sessionId":"<id>")
     *   - session-env/<id>/            (per-session env dir)
     *   - todos/<id>*                  (todo files)
     *   - sessions/*.json              (runtime files referencing the id)
     */
    async deleteSession(info: SessionInfo): Promise<void> {
        const home = os.homedir();
        const root = path.join(home, ".claude");
        const id = info.sessionId;

        const transcript = info.transcriptPath ?? await this.findTranscript(id);
        if (transcript) {
            await fs.promises.rm(transcript, { force: true });
        }
        await fs.promises.rm(path.join(root, "session-env", id), { recursive: true, force: true });
        await removeMatchingFiles(path.join(root, "todos"), (name) => name.startsWith(id));
        await scrubJsonlLines(path.join(root, "history.jsonl"), (entry) => entry?.sessionId === id);
        await removeMatchingFiles(path.join(root, "sessions"), undefined, async (full) => {
            try {
                const data = JSON.parse(await fs.promises.readFile(full, "utf8"));
                return data?.sessionId === id;
            } catch {
                return false;
            }
        });
    }

    /**
     * Rebuilds the dialogue from the transcript JSONL. Tool noise is
     * reduced to one line per tool call; meta/system entries are skipped.
     */
    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        const file = info.transcriptPath ?? await this.findTranscript(info.sessionId);
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
            messages.push(...parseTranscriptLine(line));
        }
        return messages;
    }

    /**
     * Read-only live mirror: tails the transcript JSONL, emitting messages
     * appended after the current end of file. Used to watch a session that
     * is running in another process (e.g. an interactive terminal) without
     * touching it — sending is intentionally not offered for followed
     * sessions, since two writers on one session id diverge.
     */
    follow(info: SessionInfo, onMessage: (message: HistoryMessage) => void): FollowHandle {
        let file = info.transcriptPath;
        let offset = 0;
        let carry = "";
        let closed = false;
        let reading = false;
        let watcher: fs.FSWatcher | undefined;

        const drain = async () => {
            if (closed || reading || !file) {
                return;
            }
            reading = true;
            try {
                const stat = await fs.promises.stat(file);
                if (stat.size < offset) {
                    // File was truncated/rotated; restart from the top.
                    offset = 0;
                    carry = "";
                }
                if (stat.size > offset) {
                    const stream = fs.createReadStream(file, { start: offset, encoding: "utf8" });
                    for await (const chunk of stream) {
                        carry += chunk;
                        const lines = carry.split("\n");
                        carry = lines.pop() ?? "";
                        for (const line of lines) {
                            for (const message of parseTranscriptLine(line)) {
                                onMessage(message);
                            }
                        }
                    }
                    offset = stat.size;
                }
            } catch {
                // transient read errors are ignored; the next event retries
            } finally {
                reading = false;
            }
        };

        const begin = async () => {
            if (!file) {
                file = await this.findTranscript(info.sessionId);
            }
            if (!file || closed) {
                return;
            }
            try {
                offset = (await fs.promises.stat(file)).size;
            } catch {
                offset = 0;
            }
            try {
                watcher = fs.watch(file, () => void drain());
            } catch {
                // fall back to polling if the platform can't watch the file
            }
            const timer = setInterval(() => void drain(), 1500);
            const stopTimer = () => clearInterval(timer);
            this._followStops.set(info.sessionId, stopTimer);
        };

        void begin();

        return {
            dispose: () => {
                closed = true;
                watcher?.close();
                this._followStops.get(info.sessionId)?.();
                this._followStops.delete(info.sessionId);
            },
        };
    }

    private readonly _followStops = new Map<string, () => void>();

    private async findTranscript(sessionId: string): Promise<string | undefined> {
        const root = path.join(os.homedir(), ".claude", "projects");
        let projectDirs: string[];
        try {
            projectDirs = await fs.promises.readdir(root);
        } catch {
            return undefined;
        }
        for (const dir of projectDirs) {
            const candidate = path.join(root, dir, `${sessionId}.jsonl`);
            try {
                await fs.promises.access(candidate);
                return candidate;
            } catch {
                // not in this project dir
            }
        }
        return undefined;
    }
}

/**
 * Cleans a stored user message for display: slash-command invocations are
 * saved with a `<command-name>/<command-args>`/`<command-message>` envelope
 * (plus a `<local-command-*>`/caveat) — collapse those to `/name args`, and
 * drop other injected `<...>` system wrappers, so the transcript reads like
 * the chat the user actually typed.
 */
function cleanUserText(raw: string): string {
    const text = String(raw);
    const name = /<command-name>([^<]*)<\/command-name>/.exec(text);
    if (name) {
        const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
        const cmd = name[1].trim().replace(/^\//, "");
        return ("/" + cmd + (args && args[1].trim() ? " " + args[1].trim() : "")).trim();
    }
    // System reminders / caveats wrapped in tags are not user input.
    if (/^<(local-command|command-message|system-reminder|command-stdout)/.test(text.trim())) {
        return "";
    }
    return text.trim();
}

/** Parses one transcript JSONL line into chat messages (text + tool calls). */
function parseTranscriptLine(line: string): HistoryMessage[] {
    if (!line.trim()) {
        return [];
    }
    let entry: any;
    try {
        entry = JSON.parse(line);
    } catch {
        return [];
    }
    if (entry.isMeta) {
        return [];
    }
    const messages: HistoryMessage[] = [];
    if (entry.type === "user") {
        const content = entry.message?.content;
        if (typeof content === "string") {
            const t = cleanUserText(content);
            t && messages.push({ role: "user", text: t });
        } else if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === "text" && block.text?.trim()) {
                    const t = cleanUserText(block.text);
                    t && messages.push({ role: "user", text: t });
                }
                // tool_result blocks are skipped: the tool line was already added
            }
        }
    } else if (entry.type === "assistant") {
        for (const block of entry.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
                messages.push({ role: "assistant", text: block.text });
            } else if (block.type === "tool_use") {
                const counts = diffCounts(block.name, block.input);
                messages.push({
                    role: "tool", text: block.name, toolName: block.name,
                    detail: summarizeToolInput(block.input), input: prettyJson(block.input),
                    added: counts?.added, removed: counts?.removed,
                    todos: extractTodos(block.name, block.input),
                    path: counts ? (block.input as any)?.file_path : undefined,
                });
            }
        }
    }
    return messages;
}

/**
 * Reads the first user prompt (title) and the session's original working
 * directory from a transcript. The cwd matters: `claude --resume` only finds
 * sessions that belong to the directory it is started in.
 */
async function readSessionMeta(file: string): Promise<{ title?: string; cwd?: string }> {
    let content: string;
    try {
        content = await fs.promises.readFile(file, "utf8");
    } catch {
        return {};
    }
    let title: string | undefined;
    let cwd: string | undefined;
    for (const line of content.split("\n").slice(0, 30)) {
        try {
            const entry = JSON.parse(line);
            if (!cwd && typeof entry.cwd === "string" && entry.cwd) {
                cwd = entry.cwd;
            }
            if (!title && entry.type === "user") {
                const c = entry.message?.content;
                if (typeof c === "string" && c.trim() && !c.startsWith("<")) {
                    title = c.slice(0, 80);
                } else if (Array.isArray(c)) {
                    const text = c.find((b: any) => b.type === "text")?.text;
                    if (text) {
                        title = String(text).slice(0, 80);
                    }
                }
            }
            if (title && cwd) {
                break;
            }
        } catch {
            // non-JSON lines are skipped
        }
    }
    return { title, cwd };
}
