import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import {
    AgentAdapter,
    AgentSession,
    SessionInfo,
    SessionStartOptions,
} from "./types";

export interface ClaudeAdapterConfig {
    executable: string;
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
        const child = spawn(this.config.executable, args, {
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
            this.emit("event", { kind: "error", message: `claude spawn failed: ${error.message}` });
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
            const child = spawn(this.getConfig().executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
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
                    sessions.push({
                        backend: "claude",
                        sessionId: path.basename(file, ".jsonl"),
                        title: await readSessionTitle(fullPath) ?? dir,
                        cwd: dir,
                        updatedAt: stat.mtime,
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
}

/** Reads the first user prompt from a transcript to use as the session title. */
async function readSessionTitle(file: string): Promise<string | undefined> {
    let content: string;
    try {
        content = await fs.promises.readFile(file, "utf8");
    } catch {
        return undefined;
    }
    for (const line of content.split("\n").slice(0, 20)) {
        try {
            const entry = JSON.parse(line);
            if (entry.type === "user" && typeof entry.message?.content === "string") {
                return entry.message.content.slice(0, 80);
            }
            if (entry.type === "user" && Array.isArray(entry.message?.content)) {
                const text = entry.message.content.find((b: any) => b.type === "text")?.text;
                if (text) {
                    return String(text).slice(0, 80);
                }
            }
        } catch {
            // non-JSON lines are skipped
        }
    }
    return undefined;
}
