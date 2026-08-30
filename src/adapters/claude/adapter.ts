import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { builtinCommands } from "../builtins";
import { resolveExecutable } from "../exec";
import { removeMatchingFiles, scrubJsonlLines } from "../scrub";
import { findNamedDirs, loadSlashCommands, mergeCommands } from "../skills";
import { PERMISSION_MODES } from "../aiTools/permissionTiers";
import { DEFAULT_REASONING_EFFORT, nativeReasoning, REASONING_MAPS } from "../reasoning";
import {
    AgentAdapter,
    AgentSession,
    FollowHandle,
    HistoryMessage,
    HistoryPage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "../types";
import { getCached, setCached, ModelCacheEntry } from "../modelCache";
import { ClaudeAdapterConfig, ClaudeSession } from "./session";
import { claudeOAuthToken } from "./credentials";
import {
    decodeHistoryCursor,
    encodeHistoryCursor,
    readJsonlRange,
    readJsonlTail,
} from "../jsonlPrefix";
import { parseTranscriptLine } from "./transcript";
import { listClaudeSessions } from "./sessionDiscovery";
import { followClaudeSession } from "./claudeFollow";
import { claudeUsage } from "./usage";
import { ClaudeTaskTracker } from "./tasks";

export class ClaudeAdapter implements AgentAdapter {
    readonly backend = "claude" as const;
    readonly usage = claudeUsage;

    constructor(private readonly getConfig: () => ClaudeAdapterConfig) {}

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        return new Promise((resolve) => {
            const child = spawn(resolveExecutable(this.getConfig().executable), ["--version"], {
                stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            child.stdout.on("data", (chunk) => {
                out += String(chunk);
            });
            child.on("error", (error) => resolve({ ok: false, error: error.message }));
            child.on("exit", (code) =>
                code === 0
                    ? resolve({ ok: true, version: out.trim() })
                    : resolve({ ok: false, error: `exit code ${code}` }),
            );
        });
    }

    async listSessions(): Promise<SessionInfo[]> {
        return listClaudeSessions([]);
    }

    async listSessionsIncremental(cached: readonly SessionInfo[]): Promise<SessionInfo[]> {
        return listClaudeSessions(cached);
    }

    start(options: SessionStartOptions): AgentSession {
        const reasoning =
            options.reasoning === undefined
                ? undefined
                : nativeReasoning(REASONING_MAPS.claude, options.reasoning);
        return new ClaudeSession(
            this.getConfig(),
            reasoning === undefined ? options : { ...options, reasoning },
        );
    }

    models(): string[] {
        const cfg = this.getConfig();
        const cached = getCached("claude");
        // Only use discovered models; no fallback hardcoded models.
        const base = cached?.models ?? [];
        const configured = cfg.model;
        return [...new Set([...(configured ? [configured] : []), ...base])];
    }

    /**
     * Fetch current Claude models from the Anthropic API. Credentials are
     * resolved in order: ANTHROPIC_API_KEY (adapter env → process env), then the
     * Claude Code CLI OAuth tokens in ~/.claude/.credentials.json (refreshed on
     * demand). Falls back to the file cache only when neither is available.
     * Updates the file cache on success.
     */
    async refreshModels(): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        const apiKey = cfg.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
        const baseUrl = (
            cfg.env?.ANTHROPIC_BASE_URL ||
            process.env.ANTHROPIC_BASE_URL ||
            "https://api.anthropic.com"
        ).replace(/\/+$/, "");

        // OAuth bearer (Claude Code login) as a fallback so model discovery works
        // for users authenticated via the CLI without a separate API key.
        const bearer = apiKey ? "" : await claudeOAuthToken();
        if (!apiKey && !bearer) {
            cfg.log?.(
                "[claude] no ANTHROPIC_API_KEY or Claude Code login — using file cache for models",
            );
            return { models: this.models(), labels: getCached("claude")?.labels ?? {} };
        }

        const cached = getCached("claude");
        try {
            const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
            if (apiKey) {
                headers["x-api-key"] = apiKey;
            } else {
                headers["authorization"] = `Bearer ${bearer}`;
            }
            const res = await fetch(`${baseUrl}/v1/models`, { headers });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const json = (await res.json()) as { data?: unknown[] };
            const raw = json?.data ?? [];
            const models: string[] = [];
            const labels: Record<string, string> = {};
            for (const m of raw) {
                if (typeof m !== "object" || m === null) {
                    continue;
                }
                const id = "id" in m && typeof m.id === "string" ? m.id : "";
                if (!id) {
                    continue;
                }
                models.push(id);
                const name =
                    "display_name" in m && typeof m.display_name === "string"
                        ? m.display_name
                        : undefined;
                if (name && name !== id) {
                    labels[id] = name;
                }
            }
            if (models.length) {
                const entry: ModelCacheEntry = {
                    models,
                    labels,
                    lastUpdate: new Date().toISOString(),
                };
                setCached("claude", entry);
                cfg.log?.(`[claude] refreshed ${models.length} models from Anthropic API`);
                const configured = cfg.model;
                return {
                    models: [...new Set([...(configured ? [configured] : []), ...models])],
                    labels,
                };
            }
        } catch (err: unknown) {
            cfg.log?.(
                `[claude] model refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        return { models: this.models(), labels: cached?.labels ?? {} };
    }

    hasNativeTodo(): boolean {
        return true;
    } // TaskCreate/TaskUpdate (previously TodoWrite)
    supportsImages(): boolean {
        return true;
    }

    // claude --effort <level> (2.1.177). "default" means: don't pass the flag.
    reasoningLevels(): string[] {
        return ["default", ...Object.keys(REASONING_MAPS.claude)];
    }

    reasoningMap(): Record<string, string> {
        return { ...REASONING_MAPS.claude };
    }

    defaultReasoning(): string {
        return DEFAULT_REASONING_EFFORT.claude;
    }

    // Unified modes shared with every adapter's picker. admin/plan map 1:1 to
    // real native --permission-mode flags (session.ts's mapUnifiedToClaudeFlag);
    // manager/user aren't enforced yet for this CLI (would need Claude's hook
    // system to reimplement the gate ourselves, matching the openai adapter) —
    // selecting them clamps to admin under the hood with a one-time notice.
    permissionModes(): string[] {
        return PERMISSION_MODES;
    }

    defaultPermission(): string {
        const configured = this.getConfig().permissionMode;
        return configured && configured !== "default" ? configured : "admin";
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
        return mergeCommands(
            builtinCommands("claude", version, this.getConfig().log),
            discovered.flat(),
        );
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

        const transcript = info.transcriptPath ?? (await this.findTranscript(id));
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
        // Claude can flush shutdown rows after its process receives SIGTERM.
        // Remove any late recreation in a bounded grace period; the persisted
        // deletion tombstone remains the final UI guard if an external Claude
        // process keeps writing this session after the grace window.
        if (transcript) {
            for (const delay of [75, 225, 700]) {
                await new Promise((resolve) => setTimeout(resolve, delay));
                await fs.promises.rm(transcript, { force: true });
            }
        }
    }

    /**
     * Rebuilds the dialogue from the transcript JSONL. Tool noise is
     * reduced to one line per tool call; meta/system entries are skipped.
     */
    async history(info: SessionInfo, cursor?: string): Promise<HistoryPage> {
        const file = info.transcriptPath ?? (await this.findTranscript(info.sessionId));
        if (!file) {
            return { messages: [] };
        }
        // Restore the recent transcript page from the physical tail. Reading a
        // 100+ MB JSONL file before opening its tab freezes the WSL extension
        // host; Claude Code likewise resumes by id instead of replaying it all.
        const endByte = decodeHistoryCursor(cursor);
        const PAGE_BYTES = 1024 * 1024;
        let content: string;
        let nextEndByte: number | undefined;
        if (endByte === undefined) {
            content = await readJsonlTail(file, 4 * 1024 * 1024);
            try {
                const stat = await fs.promises.stat(file);
                nextEndByte = Math.max(0, stat.size - 4 * 1024 * 1024);
                if (nextEndByte === 0) nextEndByte = undefined;
            } catch {
                nextEndByte = undefined;
            }
        } else {
            const range = await readJsonlRange(file, endByte, PAGE_BYTES);
            content = range.content;
            nextEndByte = range.nextEndByte;
        }
        const messages: HistoryMessage[] = [];
        const taskTracker = new ClaudeTaskTracker();
        for (const line of content.split("\n")) {
            messages.push(...parseTranscriptLine(line, taskTracker));
        }
        const nextCursor = nextEndByte !== undefined ? encodeHistoryCursor(nextEndByte) : undefined;
        return { messages, nextCursor };
    }

    /**
     * Read-only live mirror: tails the transcript JSONL, emitting messages
     * appended after the current end of file. Used to watch a session that
     * is running in another process (e.g. an interactive terminal) without
     * touching it — sending is intentionally not offered for followed
     * sessions, since two writers on one session id diverge.
     */
    follow(info: SessionInfo, onMessage: (message: HistoryMessage) => void): FollowHandle {
        return followClaudeSession(
            info,
            onMessage,
            (sessionId) => this.findTranscript(sessionId),
            this._followStops,
        );
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
