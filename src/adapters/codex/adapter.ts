import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { builtinCommands } from "../builtins";
import { resolveExecutable } from "../exec";
import { scrubJsonlLines, scrubSqliteRows } from "../scrub";
import { discoverSlashCommands, findNamedDirs, mergeCommands } from "../skills";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "../types";
import { getCached, setCached, ModelCacheEntry } from "../modelCache";
import { CodexAdapterConfig, CodexSession } from "./session";
import { looksInjected, readCodexMeta } from "./transcript";

export class CodexAdapter implements AgentAdapter {
    readonly backend = "codex" as const;

    constructor(private readonly getConfig: () => CodexAdapterConfig) { }

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

    /** Walks ~/.codex/sessions/YYYY/MM/DD for rollout-*.jsonl files. */
    async listSessions(): Promise<SessionInfo[]> {
        const root = path.join(os.homedir(), ".codex", "sessions");
        const files: string[] = [];
        const walk = async (dir: string, depth: number): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory() && depth < 3) {
                    await walk(full, depth + 1);
                } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
                    files.push(full);
                }
            }
        };
        await walk(root, 0);

        const sessions: SessionInfo[] = [];
        for (const file of files) {
            try {
                const meta = await readCodexMeta(file);
                if (!meta.id) {
                    continue;
                }
                const stat = await fs.promises.stat(file);
                sessions.push({
                    backend: "codex",
                    sessionId: meta.id,
                    title: meta.title ?? path.basename(file),
                    cwd: meta.cwd,
                    updatedAt: stat.mtime,
                    transcriptPath: file,
                });
            } catch {
                // skip unreadable rollout files
            }
        }
        sessions.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
        return sessions.slice(0, 50);
    }

    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        const file = info.transcriptPath;
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
            if (!line.trim()) {
                continue;
            }
            let entry: any;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            if (entry.type !== "response_item" || entry.payload?.type !== "message") {
                continue;
            }
            const role = entry.payload.role;
            if (role !== "user" && role !== "assistant") {
                continue; // skip developer/system scaffolding
            }
            const text = (entry.payload.content ?? [])
                .filter((c: any) => c.type === "input_text" || c.type === "output_text" || c.type === "text")
                .map((c: any) => c.text)
                .join("")
                .trim();
            // Skip the large injected scaffolding messages (instructions, skills, etc.).
            if (text && !looksInjected(text)) {
                messages.push({ role: role === "user" ? "user" : "assistant", text });
            }
        }
        return messages;
    }

    start(options: SessionStartOptions): AgentSession {
        return new CodexSession(this.getConfig(), options);
    }

    models(): string[] {
        const cfg = this.getConfig();
        const cached = getCached("codex");
        const base = cached?.models ?? [];
        const configured = cfg.model;
        return [...new Set([...(configured ? [configured] : []), ...base])];
    }

    /**
     * Fetch current OpenAI models from the API (requires OPENAI_API_KEY in
     * process env). Filters to codex-relevant models (codex/gpt-5/o4).
     * Updates file cache on success.
     */
    async refreshModels(): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        const apiKey = process.env.OPENAI_API_KEY;
        const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");

        const cached = getCached("codex");
        if (!apiKey) {
            return { models: this.models(), labels: cached?.labels };
        }

        try {
            const res = await fetch(`${baseUrl}/v1/models`, {
                headers: { authorization: `Bearer ${apiKey}` },
            });
            if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
            const json: any = await res.json();
            const raw: any[] = json?.data ?? json?.models ?? [];
            const models: string[] = [];
            const labels: Record<string, string> = {};
            for (const m of raw) {
                const id: string = typeof m === "string" ? m : (m?.id ?? "");
                if (!id) { continue; }
                // Only include models relevant to Codex (codex/gpt/o-series)
                if (!/codex|gpt|o\d/i.test(id)) { continue; }
                models.push(id);
            }
            if (models.length) {
                const entry: ModelCacheEntry = { models, labels, lastUpdate: new Date().toISOString() };
                setCached("codex", entry);
                const configured = cfg.model;
                return { models: [...new Set([...(configured ? [configured] : []), ...models])], labels };
            }
        } catch {
            // fall through to cache/fallback
        }
        return { models: this.models(), labels: cached?.labels };
    }

    hasNativeTodo(): boolean { return true; }   // update_plan / todo_list

    // codex -c model_reasoning_effort="<level>" (0.139.0). "default" = omit.
    reasoningLevels(): string[] {
        return ["default", "minimal", "low", "medium", "high"];
    }

    async commands(): Promise<SlashCommand[]> {
        const root = path.join(os.homedir(), ".codex");
        const pluginSkills = await findNamedDirs(path.join(root, "plugins"), "skills");
        const discovered = await discoverSlashCommands(
            // Codex's bundled skills live under skills/.system/<name>/SKILL.md.
            [path.join(root, "skills"), path.join(root, "skills", ".system"), ...pluginSkills],
            [path.join(root, "prompts")],
        );
        const version = (await this.available()).version;
        return mergeCommands(builtinCommands("codex", version), discovered);
    }

    /**
     * Permanently scrubs every on-disk trace of a session from Codex:
     *   - sessions/.../rollout-*-<id>.jsonl  (transcript)
     *   - session_index.jsonl                (line with "id":"<id>")
     *   - history.jsonl                       (entries for the session)
     * Returns the names of stores that may still hold residual data so the
     * caller can warn the user (e.g. the aggregate logs_*.sqlite).
     */
    async deleteSession(info: SessionInfo): Promise<string[]> {
        const root = path.join(os.homedir(), ".codex");
        const id = info.sessionId;
        if (info.transcriptPath) {
            await fs.promises.rm(info.transcriptPath, { force: true });
        }
        await scrubJsonlLines(path.join(root, "session_index.jsonl"),
            (entry) => entry?.id === id || entry?.session_id === id || entry?.thread_id === id);
        await scrubJsonlLines(path.join(root, "history.jsonl"),
            (entry) => entry?.session_id === id || entry?.id === id);

        // Codex also writes an aggregate sqlite log keyed by thread_id (= the
        // session GUID). Delete those rows and VACUUM so nothing lingers in
        // free pages; only report residual if no sqlite tool was available.
        const residual: string[] = [];
        let dbFiles: string[] = [];
        try {
            dbFiles = (await fs.promises.readdir(root)).filter((f) => /^logs.*\.sqlite$/.test(f));
        } catch {
            // ignore
        }
        for (const dbFile of dbFiles) {
            const scrubbed = await scrubSqliteRows(path.join(root, dbFile), "logs", "thread_id", id);
            if (!scrubbed) {
                residual.push(`~/.codex/${dbFile} (install python3 or sqlite3 to scrub)`);
            }
        }
        return residual;
    }
}
