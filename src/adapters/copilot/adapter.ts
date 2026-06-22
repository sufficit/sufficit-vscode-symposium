import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { builtinCommands } from "../builtins";
import { resolveExecutable } from "../exec";
import { discoverSlashCommands, findNamedDirs, mergeCommands } from "../skills";
import { TODO_INJECTION } from "../todos";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "../types";
import { getCached, setCached, ModelCacheEntry } from "../modelCache";
import { CopilotAdapterConfig, CopilotSession } from "./session";
import {
    allCopilotSessions,
    copilotTranscriptFiles,
    deleteImportedCopilotSession,
    transcriptHistory,
} from "./transcripts";

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
     * Copilot CLI itself does not expose a list command, but VS Code Copilot
     * Chat stores transcripts in workspaceStorage/GitHub.copilot-chat. Import
     * those as read/history sessions so Symposium's list matches the native
     * Copilot Chat sessions view (including code-server).
     */
    async listSessions(): Promise<SessionInfo[]> {
        const all = allCopilotSessions();
        const out: SessionInfo[] = [];
        for (const [id, e] of all) {
            out.push({
                backend: "copilot" as const,
                sessionId: id,
                title: e.label,
                updatedAt: e.updatedTs ? new Date(e.updatedTs) : undefined,
                transcriptPath: e.isTranscript ? copilotTranscriptFiles().find((f) => path.basename(f, ".jsonl") === id) : undefined,
            });
        }
        return out.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    }

    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        const file = info.transcriptPath ?? copilotTranscriptFiles().find((p) => path.basename(p, ".jsonl") === info.sessionId);
        return file ? transcriptHistory(file) : [];
    }

    async deleteSession(info: SessionInfo): Promise<string[] | void> {
        return deleteImportedCopilotSession(info);
    }

    start(options: SessionStartOptions): AgentSession {
        return new CopilotSession(this.getConfig(), options);
    }

    models(): string[] {
        const cfg = this.getConfig();
        const cached = getCached("copilot");
        const base = cached?.models ?? [];
        const configured = cfg.model;
        // "auto" is always first: Copilot's own model-routing mode
        return [...new Set(["auto", ...(configured && configured !== "auto" ? [configured] : []), ...base])];
    }

    /**
     * Read the most recently modified models.json written by the VS Code Copilot
     * extension under workspaceStorage/<id>/GitHub.copilot-chat/debug-logs. No API
     * call or token needed — the extension fetches and caches it locally.
     */
    async refreshModels(): Promise<{ models: string[]; labels?: Record<string, string> }> {
        try {
            const wsStorage = path.join(os.homedir(), ".config", "Code", "User", "workspaceStorage");
            if (!fs.existsSync(wsStorage)) { return { models: this.models() }; }
            // Find all models.json files under copilot debug-logs
            const candidates: { mtime: number; file: string }[] = [];
            for (const ws of fs.readdirSync(wsStorage)) {
                const logsDir = path.join(wsStorage, ws, "GitHub.copilot-chat", "debug-logs");
                if (!fs.existsSync(logsDir)) { continue; }
                for (const session of fs.readdirSync(logsDir)) {
                    const f = path.join(logsDir, session, "models.json");
                    try {
                        const st = fs.statSync(f);
                        candidates.push({ mtime: st.mtimeMs, file: f });
                    } catch { /* skip */ }
                }
            }
            if (!candidates.length) { return { models: this.models() }; }
            candidates.sort((a, b) => b.mtime - a.mtime);
            const raw = JSON.parse(fs.readFileSync(candidates[0].file, "utf8"));
            const list: any[] = Array.isArray(raw) ? raw : (raw?.models ?? []);
            const models: string[] = [];
            const labels: Record<string, string> = {};
            for (const m of list) {
                const id: string = m?.id ?? "";
                if (!id) { continue; }
                // Skip internal routing / embedding models
                if (m?.capabilities?.type && m.capabilities.type !== "chat") { continue; }
                if (/-picker$|-secondary$|-tertiary$|trajectory-compaction/.test(id)) { continue; }
                models.push(id);
                const name: string = m?.name ?? "";
                if (name && name !== id) { labels[id] = name; }
            }
            if (models.length) {
                const entry: ModelCacheEntry = { models, labels, lastUpdate: new Date().toISOString() };
                setCached("copilot", entry);
                const cfg = this.getConfig();
                const configured = cfg.model;
                return {
                    models: [...new Set(["auto", ...(configured && configured !== "auto" ? [configured] : []), ...models])],
                    labels,
                };
            }
        } catch { /* fall through */ }
        return { models: this.models(), labels: getCached("copilot")?.labels };
    }

    // No native plan/todo tool: Symposium injects one and parses a ```todo block.
    hasNativeTodo(): boolean { return false; }
    todoInjection(): string { return TODO_INJECTION; }

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
