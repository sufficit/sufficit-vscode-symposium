import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { builtinCommands } from "../builtins";
import { resolveExecutable } from "../exec";
import { removeMatchingFiles, scrubJsonlLines } from "../scrub";
import { findNamedDirs, loadSlashCommands, mergeCommands } from "../skills";
import {
    AgentAdapter,
    AgentSession,
    FollowHandle,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "../types";
import { getCached, setCached, ModelCacheEntry } from "../modelCache";
import { ClaudeAdapterConfig, ClaudeSession } from "./session";
import { CLAUDE_FALLBACK_LABELS, CLAUDE_FALLBACK_MODELS } from "./models";
import { parseTranscriptLine, rawLineType, readSessionMeta } from "./transcript";

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
                        gitBranch: meta.gitBranch,
                        lineageId: meta.originSessionId,
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
        const cfg = this.getConfig();
        const cached = getCached("claude");
        // Prefer discovered models; fall back to the known-model list when the
        // discovery cache is still empty (e.g. CLI auth without API key).
        const base = cached?.models?.length ? cached.models : CLAUDE_FALLBACK_MODELS;
        const configured = cfg.model;
        return [...new Set([...(configured ? [configured] : []), ...base])];
    }

    /**
     * Fetch current Claude models from Anthropic API (requires ANTHROPIC_API_KEY
     * in adapter env or process env). Falls back to file cache, then the CLAUDE_FALLBACK_MODELS list.
     * Updates file cache on success.
     */
    async refreshModels(): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        const apiKey = cfg.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
        const baseUrl = (cfg.env?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");

        const cached = getCached("claude");
        if (!apiKey) {
            cfg.log?.("[claude] no ANTHROPIC_API_KEY — using fallback/file cache for models");
            return { models: this.models(), labels: { ...CLAUDE_FALLBACK_LABELS, ...(cached?.labels ?? {}) } };
        }

        // Skip if cache is fresh and caller didn't force a refresh
        try {
            const res = await fetch(`${baseUrl}/v1/models`, {
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                },
            });
            if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
            const json = await res.json() as { data?: unknown[] };
            const raw = json?.data ?? [];
            const models: string[] = [];
            const labels: Record<string, string> = {};
            for (const m of raw) {
                if (typeof m !== "object" || m === null) { continue; }
                const id = "id" in m && typeof m.id === "string" ? m.id : "";
                if (!id) { continue; }
                models.push(id);
                const name = "display_name" in m && typeof m.display_name === "string" ? m.display_name : undefined;
                if (name && name !== id) { labels[id] = name; }
            }
            if (models.length) {
                const entry: ModelCacheEntry = { models, labels, lastUpdate: new Date().toISOString() };
                setCached("claude", entry);
                cfg.log?.(`[claude] refreshed ${models.length} models from Anthropic API`);
                const configured = cfg.model;
                return { models: [...new Set([...(configured ? [configured] : []), ...models])], labels };
            }
        } catch (err: unknown) {
            cfg.log?.(`[claude] model refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { models: this.models(), labels: { ...CLAUDE_FALLBACK_LABELS, ...(cached?.labels ?? {}) } };
    }

    hasNativeTodo(): boolean { return true; }   // TodoWrite
    supportsImages(): boolean { return true; }

    // claude --effort <level> (2.1.177). "default" means: don't pass the flag.
    reasoningLevels(): string[] {
        return ["default", "low", "medium", "high", "xhigh", "max"];
    }

    permissionModes(): string[] {
        return ["default", "acceptEdits", "bypassPermissions", "plan"];
    }

    defaultPermission(): string {
        return this.getConfig().permissionMode || "default";
    }

    async commands(): Promise<SlashCommand[]> {
        const root = path.join(os.homedir(), ".claude");
        const marketplaces = path.join(root, "plugins", "marketplaces");
        const pluginRoots = await findNamedDirs(marketplaces, "skills");
        const discovered = await Promise.all([
            loadSlashCommands(path.join(root, "skills")),
            loadSlashCommands(path.join(root, "commands")),
            ...pluginRoots.map((r) => loadSlashCommands(r)),
        ]);
        const version = (await this.available()).version;
        return mergeCommands(builtinCommands("claude", version, this.getConfig().log), discovered.flat());
    }

    /**
     * Permanently scrubs every on-disk trace of a session from Claude Code,
     * not just the transcript — so a deleted session leaves no recoverable
     * data behind:
     *   - projects/<cwd>/<id>.jsonl   (transcript)
     *   - history.jsonl                (lines with "sessionId":"<id>")
     *   - session-env/<id>/            (per-session env dir)
     *   - todos/<id>*                  (todo files)
     *   - sessions/*.json              (runtime files referencing the id)
     */
    async deleteSession(info: SessionInfo): Promise<void> {
        const home = os.homedir();
        const root = path.join(home, ".claude");
        const id = info.sessionId;

        const transcript = info.transcriptPath ?? await this.findTranscript(id);
        if (transcript) {
            await fs.promises.rm(transcript, { force: true });
        }
        await fs.promises.rm(path.join(root, "session-env", id), { recursive: true, force: true });
        await removeMatchingFiles(path.join(root, "todos"), (name) => name.startsWith(id));
        await scrubJsonlLines(path.join(root, "history.jsonl"), (entry) => entry?.sessionId === id);
        await removeMatchingFiles(path.join(root, "sessions"), undefined, async (full) => {
            try {
                const data = JSON.parse(await fs.promises.readFile(full, "utf8"));
                return data?.sessionId === id;
            } catch {
                return false;
            }
        });
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
            messages.push(...parseTranscriptLine(line));
        }
        return messages;
    }

    /**
     * Read-only live mirror: tails the transcript JSONL, emitting messages
     * appended after the current end of file. Used to watch a session that
     * is running in another process (e.g. an interactive terminal) without
     * touching it — sending is intentionally not offered for followed
     * sessions, since two writers on one session id diverge.
     */
    follow(info: SessionInfo, onMessage: (message: HistoryMessage) => void): FollowHandle {
        let file = info.transcriptPath;
        let offset = 0;
        let carry = "";
        let closed = false;
        let reading = false;
        let watcher: fs.FSWatcher | undefined;

        // Inferred turn state for a session running in another process: there is
        // no local AgentSession to ask `isBusy`, so we read it off the JSONL we
        // already tail. Claude Code writes a `type:"result"` line at the end of
        // every turn (the same signal ClaudeSession clears `turnActive` on), so:
        //   user/assistant line → working;  result line → idle.
        // A debounced fallback forces idle if `result` never arrives (crash/kill).
        const IDLE_FALLBACK_MS = 9000;
        let statusCb: ((status: "working" | "idle") => void) | undefined;
        let lastStatus: "working" | "idle" | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const emitStatus = (s: "working" | "idle") => {
            if (s === lastStatus) { return; }     // only on transition
            lastStatus = s;
            statusCb?.(s);
        };
        const clearIdleTimer = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
        const setStatus = (s: "working" | "idle") => {
            if (s === "working") {
                emitStatus("working");
                clearIdleTimer();
                idleTimer = setTimeout(() => emitStatus("idle"), IDLE_FALLBACK_MS);
            } else {
                clearIdleTimer();
                emitStatus("idle");
            }
        };

        const drain = async () => {
            if (closed || reading || !file) {
                return;
            }
            reading = true;
            try {
                const stat = await fs.promises.stat(file);
                if (stat.size < offset) {
                    // File was truncated/rotated; restart from the top.
                    offset = 0;
                    carry = "";
                }
                if (stat.size > offset) {
                    const stream = fs.createReadStream(file, { start: offset, encoding: "utf8" });
                    for await (const chunk of stream) {
                        carry += chunk;
                        const lines = carry.split("\n");
                        carry = lines.pop() ?? "";
                        for (const line of lines) {
                            const t = rawLineType(line);
                            if (t === "result") { setStatus("idle"); }
                            else if (t === "user" || t === "assistant") { setStatus("working"); }
                            for (const message of parseTranscriptLine(line)) {
                                onMessage(message);
                            }
                        }
                    }
                    offset = stat.size;
                }
            } catch {
                // transient read errors are ignored; the next event retries
            } finally {
                reading = false;
            }
        };

        const begin = async () => {
            if (!file) {
                file = await this.findTranscript(info.sessionId);
            }
            if (!file || closed) {
                return;
            }
            try {
                offset = (await fs.promises.stat(file)).size;
            } catch {
                offset = 0;
            }
            try {
                watcher = fs.watch(file, () => void drain());
            } catch {
                // fall back to polling if the platform can't watch the file
            }
            const timer = setInterval(() => void drain(), 1500);
            const stopTimer = () => clearInterval(timer);
            this._followStops.set(info.sessionId, stopTimer);
        };

        void begin();

        return {
            onStatus: (cb) => { statusCb = cb; },
            dispose: () => {
                closed = true;
                clearIdleTimer();
                watcher?.close();
                this._followStops.get(info.sessionId)?.();
                this._followStops.delete(info.sessionId);
            },
        };
    }

    private readonly _followStops = new Map<string, () => void>();

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
