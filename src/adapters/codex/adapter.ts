import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { builtinCommands } from "../builtins";
import { resolveExecutable } from "../exec";
import { scrubJsonlLines, scrubSqliteRows } from "../scrub";
import { findNamedDirs, loadSlashCommands, mergeCommands } from "../skills";
import { PERMISSION_MODES } from "../aiTools/permissionTiers";
import { DEFAULT_REASONING_EFFORT, nativeReasoning, REASONING_MAPS } from "../reasoning";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    HistoryPage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "../types";
import {
    decodeHistoryCursor,
    encodeHistoryCursor,
    readJsonlRange,
    readJsonlTail,
} from "../jsonlPrefix";
import { getCached, setCached, ModelCacheEntry } from "../modelCache";
import { CodexSession } from "./session";
import { CodexAdapterConfig } from "./codexMcpConfig";
import { looksInjected } from "./transcript";
import { listCodexSessions } from "./sessionDiscovery";
import { parseCodexModelCatalog } from "./models";
import { codexUsage } from "./usage";

function runCodexDebugModels(executable: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveExecutable(executable), ["debug", "models"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code !== 0) {
                reject(new Error(`codex debug models exited with code ${code}: ${stderr.trim()}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (error) {
                reject(error);
            }
        });
    });
}

export class CodexAdapter implements AgentAdapter {
    readonly backend = "codex" as const;
    readonly usage = codexUsage;

    constructor(private readonly getConfig: () => CodexAdapterConfig) {}

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
                    ? resolve({ ok: true, version: out.trim().split("\n")[0] })
                    : resolve({ ok: false, error: `exit code ${code}` }),
            );
        });
    }

    async listSessions(): Promise<SessionInfo[]> {
        return listCodexSessions([]);
    }

    async listSessionsIncremental(cached: readonly SessionInfo[]): Promise<SessionInfo[]> {
        return listCodexSessions(cached);
    }

    async history(info: SessionInfo, cursor?: string): Promise<HistoryPage> {
        const file = info.transcriptPath;
        if (!file) {
            return { messages: [] };
        }
        const endByte = decodeHistoryCursor(cursor);
        // First page (no cursor): read the tail. Subsequent pages: read a window
        // ending at the cursor's byte offset, paging backwards towards the start.
        const PAGE_BYTES = 1024 * 1024;
        let content: string;
        let nextEndByte: number | undefined;
        if (endByte === undefined) {
            content = await readJsonlTail(file, 4 * 1024 * 1024);
            // The tail reaches EOF; the next older page ends at the byte offset
            // where the tail window began.
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
        const messages = parseCodexHistory(content, info.model);
        const nextCursor = nextEndByte !== undefined ? encodeHistoryCursor(nextEndByte) : undefined;
        return { messages, nextCursor };
    }

    start(options: SessionStartOptions): AgentSession {
        const config = this.getConfig();
        const mappedConfig = {
            ...config,
            reasoning: nativeReasoning(REASONING_MAPS.codex, config.reasoning),
        };
        const reasoning =
            options.reasoning === undefined
                ? undefined
                : nativeReasoning(REASONING_MAPS.codex, options.reasoning);
        return new CodexSession(
            mappedConfig,
            reasoning === undefined ? options : { ...options, reasoning },
        );
    }

    models(): string[] {
        const cfg = this.getConfig();
        const cached = getCached("codex");
        const base = cached?.models ?? [];
        const configured = cfg.model;
        return [...new Set([...(configured ? [configured] : []), ...base])];
    }

    async refreshModels(): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        const cached = getCached("codex");
        try {
            const json = await runCodexDebugModels(cfg.executable);
            const { models, labels } = parseCodexModelCatalog(json, cfg.model);
            if (models.length) {
                const entry: ModelCacheEntry = {
                    models,
                    labels,
                    lastUpdate: new Date().toISOString(),
                };
                setCached("codex", entry);
                return { models, labels };
            }
        } catch {
            // fall through to cache/fallback
        }
        return { models: this.models(), labels: cached?.labels };
    }

    hasNativeTodo(): boolean {
        return true;
    } // update_plan / todo_list

    // codex -c model_reasoning_effort="<level>" (0.139.0). "default" = omit.
    reasoningLevels(): string[] {
        return ["default", ...Object.keys(REASONING_MAPS.codex)];
    }

    reasoningMap(): Record<string, string> {
        return { ...REASONING_MAPS.codex };
    }

    defaultReasoning(): string {
        return DEFAULT_REASONING_EFFORT.codex;
    }

    // Unified modes shared with every adapter's picker. admin/plan map 1:1 to
    // real native approval_policy+sandbox flags (session.ts's
    // mapUnifiedToCodexFlags); manager/user aren't enforced yet for this CLI —
    // selecting them clamps to admin's flags with a one-time notice.
    permissionModes(): string[] {
        return PERMISSION_MODES;
    }

    defaultPermission(): string {
        const configured = this.getConfig().approvalPolicy;
        return configured && configured !== "default" ? configured : "admin";
    }

    async commands(): Promise<SlashCommand[]> {
        const root = path.join(os.homedir(), ".codex");
        const pluginSkills = await findNamedDirs(path.join(root, "plugins"), "skills");
        const discovered = await Promise.all([
            loadSlashCommands(path.join(root, "skills")),
            loadSlashCommands(path.join(root, "prompts")),
            ...pluginSkills.map((r) => loadSlashCommands(r)),
        ]);
        const version = (await this.available()).version;
        return mergeCommands(builtinCommands("codex", version), ...discovered);
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
        await scrubJsonlLines(
            path.join(root, "session_index.jsonl"),
            (entry) => entry?.id === id || entry?.session_id === id || entry?.thread_id === id,
        );
        await scrubJsonlLines(
            path.join(root, "history.jsonl"),
            (entry) => entry?.session_id === id || entry?.id === id,
        );

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
            const scrubbed = await scrubSqliteRows(
                path.join(root, dbFile),
                "logs",
                "thread_id",
                id,
            );
            if (!scrubbed) {
                residual.push(`~/.codex/${dbFile} (install python3 or sqlite3 to scrub)`);
            }
        }
        return residual;
    }
}

/** Parses Codex rollout JSONL text into renderable HistoryMessages. */
function parseCodexHistory(content: string, defaultModel: string | undefined): HistoryMessage[] {
    const messages: HistoryMessage[] = [];
    let activeModel = defaultModel;
    for (const line of content.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        interface CodexEntry {
            type: string;
            payload?: {
                type: string;
                role?: string;
                model?: string;
                content?: Array<{ type: string; text?: string }>;
            };
        }
        const TEXT_CONTENT_TYPES = new Set(["input_text", "output_text", "text"]);
        let entry: CodexEntry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry.type === "turn_context" && typeof entry.payload?.model === "string") {
            activeModel = entry.payload.model;
            continue;
        }
        if (entry.type !== "response_item" || entry.payload?.type !== "message") {
            continue;
        }
        const role = entry.payload.role;
        if (role !== "user" && role !== "assistant") {
            continue;
        }
        const content = entry.payload.content ?? [];
        const text = content
            .filter((item) => TEXT_CONTENT_TYPES.has(item.type))
            .map((item) => item.text)
            .join("")
            .trim();
        // An image/attachment-only turn (no text part) has nothing for
        // looksInjected to judge — dispatch it with text: null instead of
        // silently dropping it, so it doesn't look like a lost message. The
        // render layer fills in a generic placeholder for null text.
        const hasNonTextContent = content.some((item) => !TEXT_CONTENT_TYPES.has(item.type));
        if (text && !looksInjected(text)) {
            messages.push({
                role,
                text,
                model: role === "assistant" ? activeModel : undefined,
            });
        } else if (!text && hasNonTextContent && role === "user") {
            messages.push({ role, text: null });
        }
    }
    return messages;
}
