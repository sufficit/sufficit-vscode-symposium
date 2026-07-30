import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { resolveExecutable } from "../exec";
import { snapshots } from "../../snapshots";
import { parseClaudeQuota } from "./usage";
import {
    contextWindowFor, diffCounts, editDiff, extractTodos,
    prettyJson, summarizeToolInput, toolFilePath, toolResultText,
} from "../parse";
import { AgentSession, SessionStartOptions } from "../types";
import { claudeResumeSessionId } from "./resume";
import { ClaudeTaskTracker } from "./tasks";
import { imageBlock } from "./images";
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
 * Maps the unified permission mode to Claude Code CLI's own native
 * --permission-mode flag. admin/plan reuse a real native mode 1:1 (safe:
 * neither one ever asks the CLI to prompt interactively). manager/user have
 * no safe native equivalent — Claude's own "acceptEdits"/"default" modes
 * expect to ask over stdin, which Symposium spawns headlessly and never
 * answers, so they'd hang on the first gated tool call. Until Claude's hook
 * system is wired up to reimplement that gate ourselves (matching what
 * turnRunner.ts already does for the openai adapter), manager/user clamp to
 * bypassPermissions and the caller shows a one-time notice explaining why.
 */
function mapUnifiedToClaudeFlag(mode: string): { flag: string; unenforced: boolean } {
    switch (mode) {
        case "admin": return { flag: "bypassPermissions", unenforced: false };
        case "plan": return { flag: "plan", unenforced: false };
        case "manager": case "user": return { flag: "bypassPermissions", unenforced: true };
        default: return { flag: mode, unenforced: false }; // legacy stored value (acceptEdits/bypassPermissions/plan)
    }
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
    private warnedUnenforcedMode = false; // emitted the manager/user "not yet enforced" notice once
    private cancelled = false;        // cancel() was called (steer) — suppress exit error
    private spawnedPermission = "";   // permission mode the live child was spawned with
    // Tool calls seen this turn with no matching tool_result yet. A backgrounded
    // Task/Agent call's own result can arrive well after the top-level "result"
    // line (the CLI keeps streaming the delegated work's events down the same
    // stdout in the meantime) — the turn isn't really over until this drains,
    // even though the CLI already considers itself ready for the next prompt.
    private pendingToolIds = new Set<string>();
    // A "result" line's turn-end, held back while pendingToolIds is non-empty
    // so busy/the working indicator doesn't drop while delegated work continues.
    private deferredTurnEnd: { costUsd: unknown; durationMs: unknown } | undefined;
    /** Claude 2.1.210 emits individual TaskCreate/TaskUpdate records, not TodoWrite snapshots. */
    private readonly taskTracker = new ClaudeTaskTracker();

    constructor(
        private readonly config: ClaudeAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        if (this.options.resumeSessionId) { this.sessionId = claudeResumeSessionId(this.options.resumeSessionId); }
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
            servers.playwright = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--browser", "chromium"] };
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
        if (!permission || permission === "default") {
            permission = "admin";
        }
        const mapped = mapUnifiedToClaudeFlag(permission);
        permission = mapped.flag;
        if (mapped.unenforced && !this.warnedUnenforcedMode) {
            this.warnedUnenforcedMode = true;
            this.emit("event", { kind: "status-notice", text: "Manager/user approval enforcement isn't implemented yet for the Claude CLI — this session is running with full permissions (admin) until that's built. The inline approval flow is live today for the Sufficit AI / OpenAI-compatible backend." });
        }
        this.spawnedPermission = permission;   // remember so send() can detect a live picker change
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
            // A failed spawn (notably ENOENT) does not reliably emit `exit`.
            // Drop the dead ChildProcess here so a later send can actually
            // spawn again instead of writing to its unusable stdin forever.
            if (this.child === child) { this.child = undefined; }
            this.turnActive = false;
            this.pendingToolIds.clear();
            this.deferredTurnEnd = undefined;
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
            if (this.child === child) { this.child = undefined; }
            // The process ended (incl. SIGINT from cancel/steer) without a final
            // result event — close the turn so the UI unblocks and the queue runs.
            if (this.turnActive && !this.disposed) {
                this.turnActive = false;
                this.emit("event", { kind: "turn-end" });
            }
            this.pendingToolIds.clear();
            this.deferredTurnEnd = undefined;
        });
        return child;
    }

    private handleLine(line: string): void {
        if (!line.trim()) {
            return;
        }
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        const quota = parseClaudeQuota(event, this.backend);
        if (quota) { this.emit("event", { kind: "quota", ...quota }); }
        switch (event.type) {
            case "stream_event": {
                // Token-level deltas (--include-partial-messages).
                const ev = typeof event.event === "object" && event.event !== null ? event.event as Record<string, unknown> : undefined;
                if (ev?.type === "content_block_delta") {
                    const delta = typeof ev.delta === "object" && ev.delta !== null ? ev.delta as Record<string, unknown> : undefined;
                    if (delta?.type === "text_delta" && typeof delta.text === "string") {
                        this.streamedText = true;
                        this.emit("event", { kind: "text", text: delta.text });
                    } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                        if (delta.thinking.trim()) {
                            this.streamedThinking = true;
                            this.emit("event", { kind: "thinking", text: delta.thinking });
                        }
                    }
                }
                break;
            }
            case "system":
                if (event.subtype === "init" && typeof event.session_id === "string") {
                    this.sessionId = event.session_id;
                    this.emit("event", { kind: "session", sessionId: event.session_id, model: typeof event.model === "string" ? event.model : undefined });
                }
                break;
            case "assistant": {
                const content = typeof event.message === "object" && event.message !== null ? (event.message as { content?: unknown[] }).content : undefined;
                for (const block of Array.isArray(content) ? content : []) {
                    if (typeof block === "object" && block !== null) {
                        const b = block as Record<string, unknown>;
                        if (b.type === "thinking" && typeof b.thinking === "string") {
                            if (!this.streamedThinking && b.thinking.trim()) { this.emit("event", { kind: "thinking", text: b.thinking }); }
                        } else if (b.type === "text" && typeof b.text === "string") {
                            // Already streamed via stream_event deltas — don't repeat.
                            if (!this.streamedText) { this.emit("event", { kind: "text", text: b.text }); }
                        } else if (b.type === "tool_use") {
                            if (typeof b.id === "string") { this.pendingToolIds.add(b.id); }
                            const counts = diffCounts(String(b.name), b.input);
                            const filePath = toolFilePath(b.input);
                            // Snapshot the file BEFORE the CLI applies the edit, so the
                            // change can be reverted later without relying on git.
                            if (counts && filePath && this.sessionId) { snapshots.capture(this.sessionId, filePath); }
                            this.emit("event", {
                                kind: "tool-start",
                                toolName: String(b.name),
                                detail: summarizeToolInput(b.input),
                                toolId: b.id,
                                input: prettyJson(b.input),
                                added: counts?.added,
                                removed: counts?.removed,
                                todos: extractTodos(String(b.name), b.input)
                                    ?? this.taskTracker.observeToolUse(String(b.name), b.input, typeof b.id === "string" ? b.id : undefined),
                                path: filePath,
                                diff: editDiff(String(b.name), b.input),
                            });
                        }
                    }
                }
                break;
            }
            case "user": {
                const userContent = typeof event.message === "object" && event.message !== null ? (event.message as { content?: unknown[] }).content : undefined;
                for (const block of Array.isArray(userContent) ? userContent : []) {
                    if (typeof block === "object" && block !== null) {
                        const b = block as Record<string, unknown>;
                        if (b.type === "tool_result") {
                            if (typeof b.tool_use_id === "string") { this.pendingToolIds.delete(b.tool_use_id); }
                            const todos = this.taskTracker.observeToolResult(
                                typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
                                event.toolUseResult,
                            );
                            this.emit("event", {
                                kind: "tool-end",
                                toolName: typeof b.tool_use_id === "string" ? b.tool_use_id : "tool",
                                toolId: b.tool_use_id,
                                result: toolResultText(b.content),
                                todos,
                            });
                        }
                    }
                }
                // A deferred turn-end (see "result" below) was waiting on exactly
                // this drain — release it now that every tool call, including a
                // backgrounded one, has a result.
                if (this.deferredTurnEnd && this.pendingToolIds.size === 0) {
                    this.turnActive = false;
                    this.emit("event", { kind: "turn-end", ...this.deferredTurnEnd });
                    this.deferredTurnEnd = undefined;
                }
                break;
            }
            case "result": {
                this.sessionId = typeof event.session_id === "string" ? event.session_id : this.sessionId;
                this.streamedText = false; this.streamedThinking = false;   // next turn streams afresh
                if (event.is_error) {
                    this.emit("event", { kind: "error", message: typeof event.result === "string" ? event.result : typeof event.subtype === "string" ? event.subtype : "unknown error" });
                }
                const u = typeof event.usage === "object" && event.usage !== null ? event.usage as Record<string, unknown> : (typeof event.message === "object" && event.message !== null ? (event.message as { usage?: unknown }).usage as Record<string, unknown> | undefined : undefined);
                if (u) {
                    const cacheRead = (typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0) + (typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0);
                    this.emit("event", {
                        kind: "usage",
                        inputTokens: (typeof u.input_tokens === "number" ? u.input_tokens : 0) + cacheRead,
                        outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
                        cacheRead,
                        contextWindow: contextWindowFor(this.options.model || this.config.model),
                    });
                }
                if (this.pendingToolIds.size > 0) {
                    // The CLI considers itself done (ready for the next prompt), but
                    // a tool call it dispatched — a backgrounded Task/Agent delegation
                    // — hasn't reported back yet, and will keep streaming its own
                    // events down this same stdout while it runs. Keep the turn (and
                    // the busy/working indicator) alive until that drains.
                    this.deferredTurnEnd = { costUsd: event.total_cost_usd, durationMs: event.duration_ms };
                } else {
                    this.turnActive = false;
                    this.emit("event", {
                        kind: "turn-end",
                        costUsd: event.total_cost_usd,
                        durationMs: event.duration_ms,
                    });
                }
                break;
            }
        }
    }

    send(text: string, images?: string[]): void {
        // Permission mode is pinned at spawn (a CLI flag), so a mid-conversation
        // change in the picker would otherwise only apply to a brand-new session.
        // When it changes, kill the live child and let ensureStarted() respawn with
        // --resume (the session id) so the new mode takes effect on THIS next message
        // while the conversation context is preserved.
        const desired = mapUnifiedToClaudeFlag(this.options.permission || this.config.permissionMode || "admin").flag;
        if (this.child && desired !== this.spawnedPermission) {
            this.config.log?.(`[claude] permission ${this.spawnedPermission} -> ${desired}; respawning with --resume`);
            this.child.kill();
            this.child = undefined;
        }
        this.turnActive = true;
        const child = this.ensureStarted();
        const content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];
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
        if (this.child) {
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
        this.child = undefined;
        this.removeAllListeners();
    }
}
