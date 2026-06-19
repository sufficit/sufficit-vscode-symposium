import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { builtinCommands } from "./builtins";
import { resolveExecutable } from "./exec";
import { snapshots } from "../snapshots";
import {
    contextWindowFor, diffCounts, editDiff, extractTodos,
    prettyJson, summarizeToolInput, toolFilePath, toolResultText,
} from "./parse";
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
} from "./types";
import { getCached, setCached, isFresh, ModelCacheEntry } from "./modelCache";

export interface ClaudeAdapterConfig {
    executable: string;
    /** Optional diagnostics sink (the Symposium output channel). */
    log?: (message: string) => void;
    model: string;
    permissionMode: string;
    env: Record<string, string>;
    /** Add the Playwright MCP server (browser navigation tools) to the session. */
    playwright?: boolean;
    /** Extra MCP servers to expose, merged into the generated --mcp-config. */
    mcpServers?: Record<string, unknown>;
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
    private turnActive = false;       // a turn is running (clear on result/exit)
    private streamedText = false;     // got text_delta this turn (skip full block)
    private streamedThinking = false; // got thinking_delta this turn (skip full block)

    constructor(
        private readonly config: ClaudeAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.options.resumeSessionId && (this.sessionId = this.options.resumeSessionId);
    }

    /**
     * Writes an MCP config file for this session (Playwright browser tools +
     * any servers from settings) and returns its path, or undefined when none.
     * Playwright MCP (@playwright/mcp) is the same engine behind VS Code's
     * Playwright tools, giving Claude assisted browser navigation.
     */
    private buildMcpConfig(): string | undefined {
        const servers: Record<string, unknown> = { ...(this.config.mcpServers ?? {}) };
        if (this.config.playwright && !servers.playwright) {
            servers.playwright = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
        }
        if (Object.keys(servers).length === 0) { return undefined; }
        try {
            const dir = path.join(os.homedir(), ".symposium");
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, "claude-mcp.json");
            fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
            return file;
        } catch (err) {
            this.config.log?.(`[claude] mcp config write failed: ${err}`);
            return undefined;
        }
    }

    private ensureStarted(): ChildProcessWithoutNullStreams {
        if (this.child) {
            return this.child;
        }
        const args = [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--include-partial-messages",   // token-level streaming deltas
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
        // Resume the LIVE session id when respawning (e.g. after a steer/cancel
        // killed the process) so the conversation continues instead of starting
        // fresh; falls back to the explicit resume id.
        const resume = this.options.resumeSessionId || this.sessionId;
        if (resume) {
            args.push("--resume", resume);
        }
        // MCP servers: Playwright browser tools (assisted navigation) + any extra
        // servers from settings. Written to a config file passed via --mcp-config.
        const mcpConfig = this.buildMcpConfig();
        if (mcpConfig) {
            args.push("--mcp-config", mcpConfig);
        }
        const executable = resolveExecutable(this.config.executable);
        this.config.log?.(`[claude] spawn ${executable} ${args.join(" ")} (cwd=${this.options.cwd})`);
        const child = spawn(executable, args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.config.env, ...this.options.env },
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
            this.turnActive = false;
            this.emit("event", { kind: "turn-end" });
        });
        child.on("exit", (code) => {
            if (!this.disposed && code !== 0 && code !== null) {
                const detail = stderr.trim().split("\n").slice(-3).join(" ");
                this.emit("event", { kind: "error", message: `claude exited with code ${code}: ${detail}` });
            }
            this.child = undefined;
            // The process ended (incl. SIGINT from cancel/steer) without a final
            // result event — close the turn so the UI unblocks and the queue runs.
            if (this.turnActive && !this.disposed) {
                this.turnActive = false;
                this.emit("event", { kind: "turn-end" });
            }
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
            case "stream_event": {
                // Token-level deltas (--include-partial-messages).
                const ev = event.event;
                if (ev?.type === "content_block_delta") {
                    if (ev.delta?.type === "text_delta" && ev.delta.text) {
                        this.streamedText = true;
                        this.emit("event", { kind: "text", text: ev.delta.text });
                    } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
                        this.streamedThinking = true;
                        this.emit("event", { kind: "thinking", text: ev.delta.thinking });
                    }
                }
                break;
            }
            case "system":
                if (event.subtype === "init") {
                    this.sessionId = event.session_id;
                    this.emit("event", { kind: "session", sessionId: event.session_id, model: event.model });
                }
                break;
            case "assistant": {
                for (const block of event.message?.content ?? []) {
                    if (block.type === "thinking" && block.thinking) {
                        if (!this.streamedThinking) { this.emit("event", { kind: "thinking", text: block.thinking }); }
                    } else if (block.type === "text" && block.text) {
                        // Already streamed via stream_event deltas — don't repeat.
                        if (!this.streamedText) { this.emit("event", { kind: "text", text: block.text }); }
                    } else if (block.type === "tool_use") {
                        const counts = diffCounts(block.name, block.input);
                        const filePath = toolFilePath(block.input);
                        // Snapshot the file BEFORE the CLI applies the edit, so the
                        // change can be reverted later without relying on git.
                        if (counts && filePath && this.sessionId) { snapshots.capture(this.sessionId, filePath); }
                        this.emit("event", {
                            kind: "tool-start",
                            toolName: block.name,
                            detail: summarizeToolInput(block.input),
                            toolId: block.id,
                            input: prettyJson(block.input),
                            added: counts?.added,
                            removed: counts?.removed,
                            todos: extractTodos(block.name, block.input),
                            path: filePath,
                            diff: editDiff(block.name, block.input),
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
            case "result": {
                this.sessionId = event.session_id ?? this.sessionId;
                this.streamedText = false; this.streamedThinking = false;   // next turn streams afresh
                if (event.is_error) {
                    this.emit("event", { kind: "error", message: event.result ?? event.subtype ?? "unknown error" });
                }
                const u = event.usage ?? event.message?.usage;
                if (u) {
                    const cacheRead = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
                    this.emit("event", {
                        kind: "usage",
                        inputTokens: (u.input_tokens ?? 0) + cacheRead,
                        outputTokens: u.output_tokens ?? 0,
                        cacheRead,
                        contextWindow: contextWindowFor(this.options.model || this.config.model),
                    });
                }
                this.turnActive = false;
                this.emit("event", {
                    kind: "turn-end",
                    costUsd: event.total_cost_usd,
                    durationMs: event.duration_ms,
                });
                break;
            }
        }
    }

    send(text: string, images?: string[]): void {
        this.turnActive = true;
        const child = this.ensureStarted();
        const content: any[] = [];
        for (const img of images ?? []) {
            const block = imageBlock(img);
            if (block) { content.push(block); }
        }
        content.push({ type: "text", text });
        const message = { type: "user", message: { role: "user", content } };
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

/** Reads an image file into an Anthropic base64 image content block. */
function imageBlock(file: string): any | undefined {
    const ext = (file.split(".").pop() || "").toLowerCase();
    const media = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "";
    if (!media) { return undefined; }
    try {
        const data = fs.readFileSync(file).toString("base64");
        return { type: "image", source: { type: "base64", media_type: media, data } };
    } catch { return undefined; }
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
        const cfg = this.getConfig();
        const cached = getCached("claude");
        const base = cached?.models ?? [];
        const configured = cfg.model;
        return [...new Set([...(configured ? [configured] : []), ...base])];
    }

    /**
     * Fetch current Claude models from Anthropic API (requires ANTHROPIC_API_KEY
     * in adapter env or process env). Falls back to file cache, then hardcoded list.
     * Updates file cache on success.
     */
    async refreshModels(): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        const apiKey = cfg.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
        const baseUrl = (cfg.env?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");

        const cached = getCached("claude");
        if (!apiKey) {
            cfg.log?.("[claude] no ANTHROPIC_API_KEY — using file cache for models");
            return { models: this.models(), labels: cached?.labels };
        }

        // Skip if cache is fresh and caller didn't force a refresh
        try {
            const res = await fetch(`${baseUrl}/v1/models`, {
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                },
            });
            if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
            const json: any = await res.json();
            const raw: any[] = json?.data ?? [];
            const models: string[] = [];
            const labels: Record<string, string> = {};
            for (const m of raw) {
                const id: string = typeof m === "string" ? m : (m?.id ?? "");
                if (!id) { continue; }
                models.push(id);
                const name = typeof m?.display_name === "string" ? m.display_name : undefined;
                if (name && name !== id) { labels[id] = name; }
            }
            if (models.length) {
                const entry: ModelCacheEntry = { models, labels, lastUpdate: new Date().toISOString() };
                setCached("claude", entry);
                cfg.log?.(`[claude] refreshed ${models.length} models from Anthropic API`);
                const configured = cfg.model;
                return { models: [...new Set([...(configured ? [configured] : []), ...models])], labels };
            }
        } catch (err: any) {
            cfg.log?.(`[claude] model refresh failed: ${err?.message ?? err}`);
        }
        return { models: this.models(), labels: cached?.labels };
    }

    hasNativeTodo(): boolean { return true; }   // TodoWrite
    supportsImages(): boolean { return true; }

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
            if (block.type === "thinking" && block.thinking?.trim()) {
                messages.push({ role: "thinking", text: block.thinking });
            } else if (block.type === "text" && block.text?.trim()) {
                messages.push({ role: "assistant", text: block.text });
            } else if (block.type === "tool_use") {
                const counts = diffCounts(block.name, block.input);
                messages.push({
                    role: "tool", text: block.name, toolName: block.name,
                    detail: summarizeToolInput(block.input), input: prettyJson(block.input),
                    added: counts?.added, removed: counts?.removed,
                    todos: extractTodos(block.name, block.input),
                    path: toolFilePath(block.input),
                    diff: editDiff(block.name, block.input),
                });
            }
        }
    } else if (entry.type === "result" && entry.is_error) {
        // A failed turn (e.g. usage/session limit) is stored as a `result`
        // entry with is_error. Re-render it as an error row so reloaded
        // history keeps the same red styling it had when it happened live.
        const msg = (typeof entry.result === "string" && entry.result.trim())
            ? entry.result.trim()
            : (entry.subtype ?? "unknown error");
        messages.push({ role: "error", text: msg });
    }
    // Stamp the transcript time so history shows real timestamps on hover.
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(ts)) { for (const m of messages) { m.ts = ts; } }
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
