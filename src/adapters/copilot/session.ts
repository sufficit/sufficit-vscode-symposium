import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveExecutable } from "../exec";
import { AgentSession, SessionStartOptions } from "../types";

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

/**
 * Drives the GitHub Copilot CLI in non-interactive JSONL mode:
 * `copilot -p <text> --output-format json`, one process per turn,
 * continuity via `--resume <session-id>` (the final "result" event
 * carries the session id). The native `--acp` server is the planned
 * upgrade path for persistent bidirectional sessions.
 */
export class CopilotSession extends EventEmitter implements AgentSession {
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
        // Per-turn flag: without the reset, one session.error would suppress
        // the nonzero-exit fallback error for every later turn.
        this.reportedError = false;
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
        let event: { type: string; [key: string]: unknown };
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        switch (event.type) {
            case "assistant.message": {
                const data = typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : {};
                const content = data.content;
                if (typeof content === "string" && content) {
                    this.emit("event", { kind: "text", text: content });
                }
                const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
                for (const tool of toolRequests) {
                    if (typeof tool === "object" && tool !== null) {
                        this.emit("event", { kind: "tool-start", toolName: "name" in tool && typeof tool.name === "string" ? tool.name : "tool" });
                    }
                }
                break;
            }
            case "tool.execution_start": {
                const data = typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : {};
                this.emit("event", {
                    kind: "tool-start",
                    toolName: "toolName" in data && typeof data.toolName === "string" ? data.toolName : "tool",
                });
                break;
            }
            case "tool.execution_end": {
                const data = typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : {};
                this.emit("event", { kind: "tool-end", toolName: "toolName" in data && typeof data.toolName === "string" ? data.toolName : "tool" });
                break;
            }
            case "session.error": {
                this.reportedError = true;
                const data = typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : {};
                this.emit("event", { kind: "error", message: "message" in data && typeof data.message === "string" ? data.message : "unknown copilot error" });
                break;
            }
            case "result":
                if (typeof event.sessionId === "string" && !this.sessionId) {
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
