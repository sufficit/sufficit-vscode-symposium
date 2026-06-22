import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import { resolveExecutable } from "../exec";
import { contextWindowFor, parseCodexUsage } from "../parse";
import { parseNativeTodos } from "../todos";
import { AgentSession, SessionStartOptions } from "../types";

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
export class CodexSession extends EventEmitter implements AgentSession {
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
