import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { resolveExecutable } from "./exec";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
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
        if (this.config.permissionMode && this.config.permissionMode !== "default") {
            args.push("--permission-mode", this.config.permissionMode);
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
                        this.emit("event", {
                            kind: "tool-start",
                            toolName: block.name,
                            detail: summarizeToolInput(block.input),
                        });
                    }
                }
                break;
            }
            case "user": {
                for (const block of event.message?.content ?? []) {
                    if (block.type === "tool_result") {
                        this.emit("event", { kind: "tool-end", toolName: block.tool_use_id ?? "tool" });
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

function summarizeToolInput(input: unknown): string {
    try {
        const text = JSON.stringify(input);
        return text.length > 120 ? text.slice(0, 117) + "..." : text;
    } catch {
        return "";
    }
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
            if (!line.trim()) {
                continue;
            }
            let entry: any;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            if (entry.isMeta) {
                continue;
            }
            if (entry.type === "user") {
                const content = entry.message?.content;
                if (typeof content === "string") {
                    content.trim() && messages.push({ role: "user", text: content });
                } else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text" && block.text?.trim()) {
                            messages.push({ role: "user", text: block.text });
                        }
                        // tool_result blocks are skipped: the tool line was already added
                    }
                }
            } else if (entry.type === "assistant") {
                for (const block of entry.message?.content ?? []) {
                    if (block.type === "text" && block.text?.trim()) {
                        messages.push({ role: "assistant", text: block.text });
                    } else if (block.type === "tool_use") {
                        messages.push({ role: "tool", text: `⚙ ${block.name}` });
                    }
                }
            }
        }
        return messages;
    }

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
