import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import { resolveExecutable } from "../exec";
import { contextWindowFor } from "../parse";
import { AgentSession, SessionStartOptions } from "../types";
import { isTransientErrorMessage } from "../transientError";
import {
    CodexAdapterConfig,
    codexWorkspaceArgs,
    loadVscodeMcpServers,
    mapUnifiedToCodexFlags,
} from "./codexMcpConfig";
import { CodexEventParser } from "./eventParser";
import { syncCodexSufficitMcp } from "./sufficitMcp";
import { isAutomaticSufficitMcpName } from "../sufficitMcp";

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
    /** Guards against a duplicate turn-end for the current turn — `codex exec
     *  --json` has been observed emitting more than one completion-shaped
     *  line (protocol `turn.completed` plus a process-exit path) for a single
     *  logical turn. A double turn-end used to re-run the controller's
     *  queue-drain logic a second time, which could dispatch the next queued
     *  message outside of any real busy turn. Reset once per spawnTurn(). */
    private turnEndEmitted = false;
    /** This turn's id, threaded onto both turn-start and turn-end so the
     *  controller's TurnTracker can correlate them (and reject a stale
     *  straggler from a superseded turn by id, not just by busy-state). */
    private currentTurnId: string | undefined;
    private effectiveModel: string;
    private vscodeMcpServers: Record<string, { command: string; args: string[] }>;
    private readonly parser: CodexEventParser;

    constructor(
        private readonly config: CodexAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.vscodeMcpServers = loadVscodeMcpServers();
        this.sessionId = options.resumeSessionId;
        this.effectiveModel = options.model || config.model;
        this.parser = new CodexEventParser({
            model: () => this.effectiveModel,
            setModel: (model) => {
                this.effectiveModel = model;
            },
            getSessionId: () => this.sessionId,
            setSessionId: (id) => {
                this.sessionId = id;
                this.options.guardrailSessionId = id;
            },
            isCancelled: () => this.cancelled,
            setReportedError: () => {
                this.reportedError = true;
            },
            configuredContextWindow: () =>
                contextWindowFor(this.options.model || this.config.model),
            emit: (event) => this.emit("event", event),
            emitTurnEnd: () => this.emitTurnEnd(),
        });
    }

    setModel(model: string): void {
        // `default` means remove this conversation's override and let the
        // configured Codex/default model take over on the next spawn.
        this.options.model = model === "default" ? undefined : model;
        this.effectiveModel = this.options.model || this.config.model;
    }

    getModel(): string {
        return this.effectiveModel || this.options.model || this.config.model;
    }

    /** Emits turn-end at most once per turn — see `turnEndEmitted`. */
    private emitTurnEnd(): void {
        if (this.turnEndEmitted) {
            this.config.log?.(
                "[codex] duplicate turn-end suppressed (already emitted for this turn)",
            );
            return;
        }
        this.turnEndEmitted = true;
        this.emit("event", { kind: "turn-end", logicalTurnId: this.currentTurnId });
    }

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
                const message = `Codex turn failed: ${error instanceof Error ? error.message : String(error)}`;
                this.emit("event", {
                    kind: "error",
                    message,
                    retryable: isTransientErrorMessage(message),
                });
                this.emitTurnEnd();
            }
        });
    }

    private async spawnTurn(text: string, sequence: number): Promise<void> {
        // Refresh and export the bearer token immediately before every spawn.
        // Extension activation performs the same sync eagerly, but awaiting it
        // here closes the race where a user starts Codex before activation or a
        // login/token-refresh callback has finished.
        const mcpSessionId =
            this.options.guardrailSessionId && !/^new-\d+$/.test(this.options.guardrailSessionId)
                ? this.options.guardrailSessionId
                : this.sessionId && !/^new-\d+$/.test(this.sessionId)
                  ? this.sessionId
                  : undefined;
        await syncCodexSufficitMcp(
            false,
            undefined,
            mcpSessionId,
            this.options.guardrailOrigin,
            true,
            this.options.permission,
        );
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
        const requestedMode = (
            this.options.permission ||
            this.config.approvalPolicy ||
            "admin"
        ).replace(/^default$/, "admin");
        const mapped = mapUnifiedToCodexFlags(requestedMode, this.config.sandboxMode);
        if (mapped.unenforced && !this.warnedUnenforcedMode) {
            this.warnedUnenforcedMode = true;
            this.emit("event", {
                kind: "status-notice",
                text: "Manager/user approval enforcement isn't implemented yet for the Codex CLI — this session is running with full permissions (admin) until that's built. The inline approval flow is live today for the Sufficit AI / OpenAI-compatible backend.",
            });
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
        const servers: Record<string, { command?: string; args?: string[] }> = {
            ...(this.config.mcpServers ?? {}),
        };
        for (const name of Object.keys(servers)) {
            if (isAutomaticSufficitMcpName(name)) {
                delete servers[name];
            }
        }
        if (this.config.playwright && !servers.playwright) {
            servers.playwright = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
        }
        // Merge VSCode MCP servers (from mcp.json), letting explicit config override
        for (const [name, server] of Object.entries(this.vscodeMcpServers)) {
            if (!isAutomaticSufficitMcpName(name) && !servers[name]) {
                servers[name] = server;
            }
        }
        for (const [name, s] of Object.entries(servers)) {
            if (s.command) {
                base.push("-c", `mcp_servers.${name}.command=${JSON.stringify(s.command)}`);
            }
            if (s.args) {
                base.push("-c", `mcp_servers.${name}.args=${JSON.stringify(s.args)}`);
            }
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
        this.turnEndEmitted = false;
        this.currentTurnId = `${this.sessionId ?? "codex"}/turn-${sequence}`;
        this.emit("event", { kind: "turn-start", logicalTurnId: this.currentTurnId });

        const rl = readline.createInterface({ input: child.stdout! });
        rl.on("line", (line) => {
            if (this.current === child) {
                this.handleLine(line);
            }
        });

        let stderr = "";
        child.stderr!.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            if (this.current !== child) {
                return;
            }
            this.current = undefined;
            if (!this.cancelled) {
                this.emit("event", {
                    kind: "error",
                    message: `codex spawn failed: ${error.message}`,
                    retryable: false,
                });
            }
            this.cancelled = false;
            this.emitTurnEnd();
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
                this.emit("event", {
                    kind: "error",
                    message: `codex exited with code ${code}: ${detail}`,
                    retryable: true,
                });
            }
            this.cancelled = false;
            this.emitTurnEnd();
        });
    }

    private handleLine(line: string): void {
        this.parser.handleLine(line);
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
