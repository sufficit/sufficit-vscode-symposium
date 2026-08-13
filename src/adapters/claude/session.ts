import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { resolveExecutable } from "../exec";
import { AgentSession, SessionStartOptions } from "../types";
import { claudeResumeSessionId } from "./resume";
import { imageBlock } from "./images";
import { ClaudeSessionCoordination } from "./sessionCoordination";
import { ClaudeAdapterConfig, mapUnifiedToClaudeFlag } from "./sessionConfig";
import { ClaudeEventParser } from "./eventParser";

export type { ClaudeAdapterConfig } from "./sessionConfig";

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
    private turnActive = false; // a turn is running (clear on result/exit)
    private warnedRootBypass = false; // emitted the root+bypassPermissions notice once
    private warnedUnenforcedMode = false; // emitted the manager/user "not yet enforced" notice once
    // Cancellation belongs to the child that received SIGINT. A new child may
    // be spawned before the old one emits its final result/exit events.
    private readonly cancelledChildren = new WeakSet<ChildProcessWithoutNullStreams>();
    private spawnedPermission = ""; // permission mode the live child was spawned with
    private spawnedModel = ""; // model passed to the live child at spawn time
    private turnChild: ChildProcessWithoutNullStreams | undefined;
    private leaseGeneration: number | undefined;
    private readonly coordination: ClaudeSessionCoordination;
    // Tool calls seen this turn with no matching tool_result yet. A backgrounded
    // Task/Agent call's own result can arrive well after the top-level "result"
    // line (the CLI keeps streaming the delegated work's events down the same
    // stdout in the meantime) — the turn isn't really over until this drains,
    // even though the CLI already considers itself ready for the next prompt.
    private readonly parser: ClaudeEventParser;

    constructor(
        private readonly config: ClaudeAdapterConfig,
        private readonly options: SessionStartOptions,
        coordination?: ClaudeSessionCoordination,
    ) {
        super();
        this.coordination = coordination ?? new ClaudeSessionCoordination({ log: config.log });
        if (this.options.resumeSessionId) {
            this.sessionId = claudeResumeSessionId(this.options.resumeSessionId);
        }
        this.parser = new ClaudeEventParser({
            model: () => this.options.model || this.config.model,
            getSessionId: () => this.sessionId,
            setSessionId: (id) => {
                this.sessionId = id;
            },
            setTurnActive: (active) => {
                this.setTurnActive(active);
            },
            emit: (event) => this.emit("event", event),
        });
    }

    private setTurnActive(active: boolean): void {
        this.turnActive = active;
        if (!active) {
            this.turnChild = undefined;
            this.leaseGeneration = this.coordination.release() ?? this.leaseGeneration;
        }
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
            // Pin to the bundled Chromium explicitly: @playwright/mcp defaults to
            // the system "chrome" channel when one is installed, and a branded
            // Google Chrome's live Safe Browsing/component-update check fails
            // closed (net::ERR_ACCESS_DENIED on every navigation) on hosts whose
            // firewall doesn't allow that outbound traffic — bundled Chromium has
            // no such check and works the same everywhere.
            servers.playwright = {
                command: "npx",
                args: ["-y", "@playwright/mcp@latest", "--browser", "chromium"],
            };
        }
        if (Object.keys(servers).length === 0) {
            return undefined;
        }
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
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages", // token-level streaming deltas
            "--verbose",
        ];
        const model = this.options.model || this.config.model;
        this.spawnedModel = model;
        if (model) {
            args.push("--model", model);
        }
        if (this.options.reasoning && this.options.reasoning !== "default") {
            args.push("--effort", this.options.reasoning);
        }
        let permission = this.options.permission || this.config.permissionMode;
        if (!permission || permission === "default") {
            permission = "admin";
        }
        const mapped = mapUnifiedToClaudeFlag(permission);
        permission = mapped.flag;
        if (mapped.unenforced && !this.warnedUnenforcedMode) {
            this.warnedUnenforcedMode = true;
            this.emit("event", {
                kind: "status-notice",
                text: "Manager/user approval enforcement isn't implemented yet for the Claude CLI — this session is running with full permissions (admin) until that's built. The inline approval flow is live today for the Sufficit AI / OpenAI-compatible backend.",
            });
        }
        this.spawnedPermission = permission; // remember so send() can detect a live picker change
        // Claude refuses bypassPermissions (= --dangerously-skip-permissions) when
        // the process runs as root (e.g. code-server@root) and exits with an error.
        // Downgrade to acceptEdits so the picker never dead-ends; for full root
        // autonomy (incl. shell) add permissions.allow to ~/.claude/settings.json.
        if (
            permission === "bypassPermissions" &&
            typeof process.getuid === "function" &&
            process.getuid() === 0
        ) {
            permission = "acceptEdits";
            this.config.log?.(
                "[claude] bypassPermissions is not allowed as root — using acceptEdits instead",
            );
            if (!this.warnedRootBypass) {
                this.warnedRootBypass = true;
                this.emit("event", {
                    kind: "text",
                    text: "_Running as root: Claude blocks bypassPermissions — using acceptEdits. For full autonomy incl. shell, add `permissions.allow` to ~/.claude/settings.json._\n\n",
                });
            }
        }
        if (permission && permission !== "default") {
            args.push("--permission-mode", permission);
        }
        // Resume the LIVE session id when respawning (e.g. after a steer/cancel
        // killed the process) so the conversation continues instead of starting
        // fresh; falls back to the explicit resume id.
        const resume = claudeResumeSessionId(this.options.resumeSessionId || this.sessionId);
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
        this.config.log?.(
            `[claude] spawn ${executable} ${args.join(" ")} (cwd=${this.options.cwd})`,
        );
        const child = spawn(executable, args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.config.env, ...this.options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;

        const rl = readline.createInterface({ input: child.stdout });
        rl.on("line", (line) => this.handleLine(line, child));

        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            this.config.log?.(`[claude] spawn error: ${error.message}`);
            if (!this.cancelledChildren.has(child)) {
                this.emit("event", {
                    kind: "error",
                    message: `claude spawn failed (${executable}): ${error.message}`,
                    // The executable/config is broken (e.g. ENOENT) — retrying
                    // the same request without fixing that won't help.
                    retryable: false,
                });
            }
            // A failed spawn (notably ENOENT) does not reliably emit `exit`.
            // Drop the dead ChildProcess here so a later send can actually
            // spawn again instead of writing to its unusable stdin forever.
            if (this.child === child) {
                this.child = undefined;
            }
            if (this.turnChild === child) {
                this.setTurnActive(false);
                this.parser.resetPending();
            }
            this.cancelledChildren.delete(child);
            if (this.turnChild === undefined) {
                this.emit("event", { kind: "turn-end" });
            }
        });
        child.on("exit", (code) => {
            const cancelled = this.cancelledChildren.has(child);
            const ownsTurn = this.turnChild === child;
            // SIGINT from cancel/steer → exit code 130 (or null). Don't emit a
            // crash error; the queue will drain the steered message on turn-end.
            if (!this.disposed && !cancelled && code !== 0 && code !== null) {
                const detail = stderr.trim().split("\n").slice(-3).join(" ");
                this.emit("event", {
                    kind: "error",
                    message: `claude exited with code ${code}: ${detail}`,
                    // The process died mid-turn without the user asking it to —
                    // the same class of failure as a dropped network connection.
                    // Retrying the identical request is the expected recovery.
                    retryable: true,
                });
            }
            this.cancelledChildren.delete(child);
            if (this.child === child) {
                this.child = undefined;
            }
            // The process ended (incl. SIGINT from cancel/steer) without a final
            // result event — close the turn so the UI unblocks and the queue runs.
            if (ownsTurn && this.turnActive) {
                this.setTurnActive(false);
                if (!this.disposed) {
                    this.emit("event", { kind: "turn-end" });
                }
            }
            if (ownsTurn || this.child === undefined) {
                this.parser.resetPending();
            }
        });
        return child;
    }

    /** Test seam and JSONL callback retained while parsing lives in ClaudeEventParser. */
    private handleLine(line: string, sourceChild?: ChildProcessWithoutNullStreams): void {
        // A canceled Claude child can flush JSON after the replacement child
        // has become the active turn. Do not let that stale result close the
        // replacement turn or mutate its pending-tool accounting.
        if (sourceChild && this.turnChild && this.turnChild !== sourceChild) {
            return;
        }
        this.parser.handleLine(line, !!sourceChild && this.cancelledChildren.has(sourceChild));
    }

    send(text: string, images?: string[]): void {
        const resume = claudeResumeSessionId(this.options.resumeSessionId || this.sessionId);
        if (resume) {
            const lease = this.coordination.acquire(resume);
            if (!lease.acquired) {
                this.config.log?.(`[claude] cross-window send blocked: ${lease.message}`);
                this.emit("event", { kind: "error", message: lease.message, retryable: true });
                this.emit("event", { kind: "turn-end" });
                return;
            }
            const contextChanged =
                lease.recoveredStaleOwner ||
                (this.leaseGeneration !== undefined && lease.generation !== this.leaseGeneration);
            if (contextChanged && this.child && !this.turnActive) {
                this.config.log?.(
                    `[claude] transcript changed in another window; respawning with --resume`,
                );
                this.cancelledChildren.add(this.child);
                this.child.kill("SIGINT");
                this.child = undefined;
            }
            this.leaseGeneration = lease.generation;
        }
        // Claude pins the model at process startup. If the picker changes in an
        // existing conversation, restart only the CLI child and resume the same
        // Claude session so the next message uses the newly selected model.
        const desiredModel = this.options.model || this.config.model;
        // Permission mode is pinned at spawn (a CLI flag), so a mid-conversation
        // change in the picker would otherwise only apply to a brand-new session.
        // When it changes, kill the live child and let ensureStarted() respawn with
        // --resume (the session id) so the new mode takes effect on THIS next message
        // while the conversation context is preserved.
        const desired = mapUnifiedToClaudeFlag(
            this.options.permission || this.config.permissionMode || "admin",
        ).flag;
        if (
            this.child &&
            (desired !== this.spawnedPermission || desiredModel !== this.spawnedModel)
        ) {
            const reason =
                desiredModel !== this.spawnedModel
                    ? `model ${this.spawnedModel || "default"} -> ${desiredModel || "default"}`
                    : `permission ${this.spawnedPermission} -> ${desired}`;
            this.config.log?.(`[claude] ${reason}; respawning with --resume`);
            if (!this.turnActive) {
                this.turnChild = undefined;
            }
            this.cancelledChildren.add(this.child);
            this.child.kill("SIGINT");
            this.child = undefined;
        }
        this.setTurnActive(true);
        let child: ChildProcessWithoutNullStreams;
        try {
            child = this.ensureStarted();
        } catch (error) {
            this.setTurnActive(false);
            throw error;
        }
        this.turnChild = child;
        const content: Array<{
            type: string;
            text?: string;
            source?: { type: string; media_type: string; data: string };
        }> = [];
        for (const img of images ?? []) {
            const block = imageBlock(img);
            if (block) {
                content.push(block);
            }
        }
        content.push({ type: "text", text });
        const message = { type: "user", message: { role: "user", content } };
        child.stdin.write(JSON.stringify(message) + "\n");
    }

    setModel(model: string): void {
        // The model is a process-level Claude CLI flag. `send()` detects the
        // difference from the live child and respawns it with --resume.
        this.options.model = model === "default" ? undefined : model;
    }

    getModel(): string {
        return this.options.model || this.config.model;
    }

    cancel(): void {
        if (this.child) {
            this.cancelledChildren.add(this.child); // suppress cancel result/exit errors
            this.child.kill("SIGINT");
            // Clear immediately so a rapid send() after steer (before the exit
            // event fires) doesn't try to reuse the dying process — ensureStarted()
            // will spawn fresh instead of writing to a dead stdin.
            this.child = undefined;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.child?.kill();
        if (!this.child) {
            this.coordination.release();
        }
        this.child = undefined;
        this.removeAllListeners();
    }
}
