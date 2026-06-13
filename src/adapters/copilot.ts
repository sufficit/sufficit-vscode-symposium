import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import * as os from "os";
import * as path from "path";
import { builtinCommands } from "./builtins";
import { resolveExecutable } from "./exec";
import { discoverSlashCommands, findNamedDirs, mergeCommands } from "./skills";
import {
    AgentAdapter,
    AgentSession,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "./types";

export interface CopilotAdapterConfig {
    executable: string;
    model: string;
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
        const child = spawn(resolveExecutable(this.config.executable), args, {
            cwd: this.options.cwd,
            env: process.env,
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
     * Copilot stores sessions in a SQLite db (~/.copilot/session-store.db)
     * and exposes no list command; until the ACP integration lands, only
     * live sessions (created in this window) can be resumed.
     */
    async listSessions(): Promise<SessionInfo[]> {
        return [];
    }

    start(options: SessionStartOptions): AgentSession {
        return new CopilotSession(this.getConfig(), options);
    }

    models(): string[] {
        const configured = this.getConfig().model;
        const known = ["auto", "claude-sonnet-4.6", "claude-haiku-4.5", "gpt-5.2", "gpt-5-mini"];
        return [...new Set([configured || "auto", ...known])];
    }

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
