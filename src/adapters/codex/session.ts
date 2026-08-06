import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import { resolveExecutable } from "../exec";
import { contextWindowFor, parseCodexUsage } from "../parse";
import { parseAdapterQuota } from "../quota";
import { parseNativeTodos } from "../todos";
import { AgentSession, SessionStartOptions } from "../types";
import { CodexAdapterConfig, codexWorkspaceArgs, loadVscodeMcpServers, mapUnifiedToCodexFlags } from "./codexMcpConfig";
import { syncCodexSufficitMcp } from "./sufficitMcp";

/** Resolve a picker value into the explicit model argument for one Codex turn. */
export function codexModelArgs(selected: string | undefined, configured: string): string[] {
    const model = selected && selected !== "default" ? selected : configured;
    return model && model !== "default" ? ["--model", model] : [];
}

/** Keeps prompts out of argv so large backend handoffs cannot exceed OS spawn limits. */
export function codexPromptArgs(sessionId: string | undefined): string[] {
    return sessionId ? ["resume", sessionId, "-"] : ["-"];
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
    private cancelled = false;
    private reportedError = false;
    private warnedUnenforcedMode = false; // emitted the manager/user "not yet enforced" notice once
    private turnSequence = 0;
    private effectiveModel: string;
    private vscodeMcpServers: Record<string, { command: string; args: string[] }>;

    constructor(
        private readonly config: CodexAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.vscodeMcpServers = loadVscodeMcpServers();
        this.sessionId = options.resumeSessionId;
        this.effectiveModel = options.model || config.model;
    }

    setModel(model: string): void {
        // `default` means remove this conversation's override and let the
        // configured Codex/default model take over on the next spawn.
        this.options.model = model === "default" ? undefined : model;
        this.effectiveModel = this.options.model || this.config.model;
    }

    getModel(): string { return this.effectiveModel || this.options.model || this.config.model; }

    send(text: string): void {
        // A mid-turn send must not leave two `codex exec` processes writing
        // the same rollout. Cancel the in-flight child before starting another.
        if (this.current) {
            this.cancelled = true;
            this.current.kill("SIGINT");
            this.current = undefined;
        }
        const sequence = ++this.turnSequence;
        void this.spawnTurn(text, sequence).catch((error) => {
            if (!this.disposed && sequence === this.turnSequence) {
                this.emit("event", { kind: "error", message: `Codex turn failed: ${error instanceof Error ? error.message : String(error)}` });
                this.emit("event", { kind: "turn-end" });
            }
        });
    }

    private async spawnTurn(text: string, sequence: number): Promise<void> {
        // Refresh and export the bearer token immediately before every spawn.
        // Extension activation performs the same sync eagerly, but awaiting it
        // here closes the race where a user starts Codex before activation or a
        // login/token-refresh callback has finished.
        await syncCodexSufficitMcp();
        if (this.disposed || sequence !== this.turnSequence) {
            return;
        }
        const base = [
            "exec",
            "--json",
            "--skip-git-repo-check",
            ...codexWorkspaceArgs(this.options.cwd, this.config.workspaceDirs),
        ];
        base.push(...codexModelArgs(this.options.model, this.config.model));
        const requestedMode = (this.options.permission || this.config.approvalPolicy || "admin").replace(/^default$/, "admin");
        const mapped = mapUnifiedToCodexFlags(requestedMode, this.config.sandboxMode);
        if (mapped.unenforced && !this.warnedUnenforcedMode) {
            this.warnedUnenforcedMode = true;
            this.emit("event", { kind: "status-notice", text: "Manager/user approval enforcement isn't implemented yet for the Codex CLI — this session is running with full permissions (admin) until that's built. The inline approval flow is live today for the Sufficit AI / OpenAI-compatible backend." });
        }
        if (mapped.approvalPolicy && mapped.approvalPolicy !== "default") {
            base.push("-c", `approval_policy="${mapped.approvalPolicy}"`);
        }
        if (mapped.sandboxMode && mapped.sandboxMode !== "default") {
            base.push("--sandbox", mapped.sandboxMode);
        }
        const reasoning = this.options.reasoning || this.config.reasoning;
        if (reasoning && reasoning !== "default") {
            base.push("-c", `model_reasoning_effort="${reasoning}"`);
        }
        // MCP servers (Playwright browser tools + extras + VSCode MCP servers) as `-c` TOML overrides.
        const servers: Record<string, { command?: string; args?: string[] }> = { ...(this.config.mcpServers ?? {}) };
        if (this.config.playwright && !servers.playwright) {
            servers.playwright = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
        }
        // Merge VSCode MCP servers (from mcp.json), letting explicit config override
        for (const [name, server] of Object.entries(this.vscodeMcpServers)) {
            if (!servers[name]) {
                servers[name] = server;
            }
        }
        for (const [name, s] of Object.entries(servers)) {
            if (s.command) { base.push("-c", `mcp_servers.${name}.command=${JSON.stringify(s.command)}`); }
            if (s.args) { base.push("-c", `mcp_servers.${name}.args=${JSON.stringify(s.args)}`); }
        }
        // Read every prompt from stdin. Backend handoffs can contain a transcript
        // larger than the operating system's argv limit (spawn E2BIG).
        const args = [...base, ...codexPromptArgs(this.sessionId)];

        const child = spawn(resolveExecutable(this.config.executable), args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.end(text);
        this.current = child;
        this.cancelled = false;
        this.reportedError = false;

        const rl = readline.createInterface({ input: child.stdout! });
        rl.on("line", (line) => {
            if (this.current === child) {
                this.handleLine(line);
            }
        });

        let stderr = "";
        child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) => {
            if (this.current !== child) {
                return;
            }
            this.current = undefined;
            if (!this.cancelled) {
                this.emit("event", { kind: "error", message: `codex spawn failed: ${error.message}` });
            }
            this.cancelled = false;
            this.emit("event", { kind: "turn-end" });
        });
        child.on("exit", (code) => {
            if (this.current !== child) {
                return;
            }
            this.current = undefined;
            if (this.disposed) {
                return;
            }
            if (!this.cancelled && code !== 0 && code !== null && !this.reportedError) {
                const detail = stderr.trim().split("\n").slice(-2).join(" ");
                this.emit("event", { kind: "error", message: `codex exited with code ${code}: ${detail}` });
            }
            this.cancelled = false;
            this.emit("event", { kind: "turn-end" });
        });
    }

    private handleLine(line: string): void {
        if (!line.trim()) {
            return;
        }
        let event: { type: string; [key: string]: unknown };
        try {
            event = JSON.parse(line);
        } catch {
            return; // non-JSON log lines (codex prints some ERROR lines plainly)
        }
        const quota = parseAdapterQuota(event, this.backend);
        if (quota) { this.emit("event", { kind: "quota", ...quota }); }
        switch (event.type) {
            case "thread.started":
                if (typeof event.thread_id === "string" && !this.sessionId) {
                    this.sessionId = event.thread_id;
                    this.emit("event", { kind: "session", sessionId: event.thread_id, model: this.effectiveModel || undefined });
                }
                break;
            case "item.started":
            case "item.completed": {
                const item = typeof event.item === "object" && event.item !== null ? event.item as Record<string, unknown> : {};
                const itemType = typeof item.type === "string" ? item.type : (typeof item.item_type === "string" ? item.item_type : undefined);
                // Codex's plan/todo updates (e.g. update_plan / todo_list).
                const todos = parseNativeTodos(itemType ?? "", item);
                if (todos) {
                    this.emit("event", { kind: "tool-start", toolName: "TodoWrite", detail: "", todos });
                    break;
                }
                if (event.type !== "item.completed") {
                    if (itemType === "command_execution" && typeof item.command === "string") {
                        this.emit("event", { kind: "tool-start", toolName: "exec", detail: item.command });
                    }
                    break;
                }
                if (itemType === "agent_message" && typeof item.text === "string") {
                    this.emit("event", { kind: "text", text: item.text, model: this.effectiveModel || undefined });
                } else if (itemType === "reasoning" && typeof item.text === "string") {
                    this.emit("event", { kind: "text", text: item.text, model: this.effectiveModel || undefined });
                } else if (itemType === "command_execution" && typeof item.command === "string") {
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
            case "turn_context": {
                const payload = typeof event.payload === "object" && event.payload !== null ? event.payload as Record<string, unknown> : {};
                if (typeof payload.model === "string" && payload.model && payload.model !== this.effectiveModel) {
                    this.effectiveModel = payload.model;
                    this.emit("event", { kind: "model", model: this.effectiveModel });
                }
                break;
            }
            case "turn.completed":
                // turn.completed may carry { usage: {...} }. Emit usage (if any)
                // BEFORE turn-end so the meter reflects the final totals.
                this.emitUsage(event);
                this.emit("event", { kind: "turn-end" });
                break;
            case "turn.failed": {
                if (this.cancelled) {
                    break;
                }
                this.reportedError = true;
                const error = typeof event.error === "object" && event.error !== null ? event.error as Record<string, unknown> : {};
                this.emit("event", { kind: "error", message: "message" in error && typeof error.message === "string" ? error.message : "codex turn failed" });
                this.emit("event", { kind: "turn-end" });
                break;
            }
            case "error": {
                const message = typeof event.message === "string" ? event.message : "codex error";
                // "Reconnecting... N/5" are transient retry notices, not failures;
                // the terminal error (or turn.failed) is surfaced separately.
                if (/^Reconnecting\.\.\./.test(message)) {
                    break;
                }
                if (this.cancelled) {
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
            model: this.effectiveModel || undefined,
        });
    }

    cancel(): void {
        this.cancelled = true;
        this.current?.kill("SIGINT");
    }

    dispose(): void {
        this.disposed = true;
        this.current?.kill();
        this.current = undefined;
        this.removeAllListeners();
    }
}
