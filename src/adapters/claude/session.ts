import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { resolveExecutable } from "../exec";
import { snapshots } from "../../snapshots";
import {
    contextWindowFor, diffCounts, editDiff, extractTodos,
    prettyJson, summarizeToolInput, toolFilePath, toolResultText,
} from "../parse";
import { AgentSession, SessionStartOptions } from "../types";

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
export class ClaudeSession extends EventEmitter implements AgentSession {
    readonly backend = "claude" as const;
    sessionId: string | undefined;
    private child: ChildProcessWithoutNullStreams | undefined;
    private disposed = false;
    private turnActive = false;       // a turn is running (clear on result/exit)
    private streamedText = false;     // got text_delta this turn (skip full block)
    private streamedThinking = false; // got thinking_delta this turn (skip full block)
    private warnedRootBypass = false; // emitted the root+bypassPermissions notice once
    private cancelled = false;        // cancel() was called (steer) — suppress exit error

    constructor(
        private readonly config: ClaudeAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        if (this.options.resumeSessionId) { this.sessionId = this.options.resumeSessionId; }
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
        let permission = this.options.permission || this.config.permissionMode;
        // Claude refuses bypassPermissions (= --dangerously-skip-permissions) when
        // the process runs as root (e.g. code-server@root) and exits with an error.
        // Downgrade to acceptEdits so the picker never dead-ends; for full root
        // autonomy (incl. shell) add permissions.allow to ~/.claude/settings.json.
        if (permission === "bypassPermissions" && typeof process.getuid === "function" && process.getuid() === 0) {
            permission = "acceptEdits";
            this.config.log?.("[claude] bypassPermissions is not allowed as root — using acceptEdits instead");
            if (!this.warnedRootBypass) {
                this.warnedRootBypass = true;
                this.emit("event", { kind: "text", text: "_Running as root: Claude blocks bypassPermissions — using acceptEdits. For full autonomy incl. shell, add `permissions.allow` to ~/.claude/settings.json._\n\n" });
            }
        }
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
            // SIGINT from cancel/steer → exit code 130 (or null). Don't emit a
            // crash error; the queue will drain the steered message on turn-end.
            if (!this.disposed && !this.cancelled && code !== 0 && code !== null) {
                const detail = stderr.trim().split("\n").slice(-3).join(" ");
                this.emit("event", { kind: "error", message: `claude exited with code ${code}: ${detail}` });
            }
            this.cancelled = false;   // reset for next spawn
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
        this.cancelled = true;   // mark so exit handler doesn't emit a crash error
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
