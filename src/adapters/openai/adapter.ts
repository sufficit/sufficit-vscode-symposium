import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "../types";
import { TODO_INJECTION } from "../todos";
import { diffCounts, editDiff, prettyJson } from "../parse";
import * as ledger from "../../ledger";
import { buildOpenAIModelList } from "../openaiModels";
import { getCached, isFresh } from "../modelCache";
import { OpenAIAdapterConfig } from "./types";
import { readStored, storeDir, storePath } from "./store";
import { contentText } from "./transform";
import {
    discoverModels, getDiscoveredLabels, getDiscoveredModels,
    hasDiscoveredModels, setDiscovered,
} from "./models";
import { friendlyToolDetail, toolPath } from "./toolDetail";
import { historyFromLedger, ledgerWasCompacted } from "./history";
import { OpenAISession } from "./session";

export class OpenAIAdapter implements AgentAdapter {
    /**
     * @param backend  unique id for this adapter instance (built-in "openai" or
     *                 a custom adapter id).
     * @param name     display name shown in the UI.
     */
    constructor(
        readonly backend: string,
        readonly displayName: string,
        private readonly getConfig: () => OpenAIAdapterConfig,
    ) { }

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        const cfg = this.getConfig();
        if (!cfg.baseUrl) { return { ok: false, error: `set baseUrl for ${this.displayName}` }; }
        // Best-effort model discovery so the picker is populated when opened.
        await discoverModels(cfg, this.backend).catch(() => undefined);
        return { ok: true, version: cfg.baseUrl };
    }

    listSessions(): Promise<SessionInfo[]> {
        const dir = storeDir(this.backend);
        let files: string[] = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { /* store dir may not exist yet */ }
        const out: SessionInfo[] = [];
        const seen = new Set<string>();
        for (const f of files) {
            const s = readStored(this.backend, f.slice(0, -5));
            if (s) {
                seen.add(s.id);
                out.push({ backend: this.backend, sessionId: s.id, title: s.title || "Session", cwd: s.cwd, updatedAt: new Date(s.updatedAt), model: s.model });
            }
        }
        // Recover orphans: sessions that have a ledger but no store file (created
        // before the constructor-persist fix, or whose store was lost). Reconstruct
        // a minimal SessionInfo from the ledger's meta.json so they reappear in
        // the UI and can be resumed.
        for (const meta of ledger.listLedgerSessions()) {
            if (meta.backend !== this.backend) { continue; }
            if (seen.has(meta.id)) { continue; }
            out.push({
                backend: this.backend,
                sessionId: meta.id,
                title: meta.title || "Session (recovered)",
                cwd: meta.cwd || "",
                updatedAt: meta.updatedAt ? new Date(meta.updatedAt) : new Date(0),
                model: meta.model || "",
            });
        }
        return Promise.resolve(out);
    }

    history(info: SessionInfo): Promise<HistoryMessage[]> {
        // Compacted sessions: the store holds only the summarized model context.
        // The lossless human transcript lives in the ledger — show that so the
        // chat still mirrors the full conversation (the model sees the summary).
        if (ledger.hasLedger(info.sessionId) && ledgerWasCompacted(info.sessionId)) {
            return Promise.resolve(historyFromLedger(info.sessionId));
        }
        const s = readStored(this.backend, info.sessionId);
        if (!s) { return Promise.resolve([]); }
        const labels = getDiscoveredLabels(this.getConfig().baseUrl) ?? {};
        // Pair each tool result back to the call that produced it.
        const results = new Map<string, string>();
        for (const m of s.messages) {
            if (m.role === "tool" && m.tool_call_id) { results.set(m.tool_call_id, contentText(m.content)); }
        }
        const out: HistoryMessage[] = [];
        for (const m of s.messages) {
            if (m.role === "user") {
                const t = contentText(m.content);
                if (t) { out.push({ role: "user", text: t }); }
            } else if (m.role === "assistant") {
                const t = contentText(m.content);
                if (t) {
                    out.push({ role: "assistant", text: t, model: m.model, modelLabel: m.model ? (labels[m.model] ?? m.model) : undefined });
                }
                // Reconstruct tool rows so a resumed (or reloaded mid-turn)
                // session shows the same icon+target+diff it had live.
                for (const tc of m.tool_calls ?? []) {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* leave empty */ }
                    const counts = diffCounts(tc.function.name, args);
                    const ap = typeof args.path === "string" && args.path
                        ? (path.isAbsolute(args.path) ? args.path : path.resolve(s.cwd, args.path))
                        : undefined;
                    out.push({
                        role: "tool", text: tc.function.name, toolName: tc.function.name,
                        detail: friendlyToolDetail(tc.function.name, args),
                        input: prettyJson(args),
                        result: results.get(tc.id),
                        added: counts?.added, removed: counts?.removed,
                        path: ap ?? toolPath(tc.function.name, args),
                        diff: editDiff(tc.function.name, args),
                    });
                }
            }
        }
        return Promise.resolve(out);
    }

    deleteSession(info: SessionInfo): Promise<void> {
        try { fs.rmSync(storePath(this.backend, info.sessionId), { force: true }); } catch { /* ignore */ }
        // Also remove the ledger repo so the session isn't left as an orphan
        // (listSessions only scans the store dir, so a ledger-only session is
        // invisible in the UI but still consumes disk space).
        try { ledger.removeLedger(info.sessionId); } catch { /* ignore */ }
        return Promise.resolve();
    }

    start(options: SessionStartOptions): AgentSession {
        return new OpenAISession(this.backend, this.getConfig(), options);
    }

    /** API backend: takes one-shot app instructions as developer messages. */
    roleAware(): boolean { return true; }

    /** Slash commands offered for this backend. `/compact` is intercepted locally
     *  (summarize + shrink the model context); it also re-enables the context
     *  popover's "Compact Conversation" button (gated on a `compact` command). */
    commands(): Promise<SlashCommand[]> {
        const builtin = [{ name: "compact", description: "Summarize older turns to shrink the model context (full history is preserved)", kind: "builtin" as const }];
        // Inline scan for skills to avoid tree-shaking in bundled extension
        try {
            const skillsDir = path.join(os.homedir(), ".symposium", "repo", "skills");
            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(skillsDir, { withFileTypes: true });
            } catch { return Promise.resolve(builtin); }
            const skills: SlashCommand[] = [];
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const skillCard = path.join(skillsDir, entry.name, "skill-card.md");
                    try {
                        const content = fs.readFileSync(skillCard, "utf8");
                        const match = content.match(/^#\s+(\S+)\s+?\n+(.+?)(?:\n---|\n\n|$)/ms);
                        if (match) {
                            const name = match[1].replace(/^\/+/, ""); // strip leading slashes
                            const description = match[2].split("\n")[0].trim();
                            skills.push({ name, description, kind: "skill" as const });
                        }
                    } catch { /* skip invalid skills */ }
                }
            }
            return Promise.resolve([...builtin, ...skills]);
        } catch (e) {
            // Fallback to builtin if scanning fails
            return Promise.resolve(builtin);
        }
    }

    /**
     * Accept inlined images (vision): attached/pasted images are sent as
     * image_url content parts so a vision-capable model sees them directly,
     * instead of being handed a file path it reads as binary. The gateway must
     * route to a vision-capable model for the image to be interpreted.
     */
    supportsImages(): boolean { return true; }

    /** Friendly id→name labels for the model picker (from discovery). */
    modelLabels(): Record<string, string> {
        return getDiscoveredLabels(this.getConfig().baseUrl) ?? {};
    }

    models(): string[] {
        const cfg = this.getConfig();
        // Seed in-memory cache from file cache when the process-level map is empty.
        if (!hasDiscoveredModels(cfg.baseUrl)) {
            const cacheKey = `openai:${cfg.baseUrl}`;
            const stored = getCached(cacheKey);
            if (stored?.models.length) {
                setDiscovered(cfg.baseUrl, stored.models, stored.labels ?? {}, stored.context);
            }
        }
        const configured = cfg.models.length ? cfg.models : (getDiscoveredModels(cfg.baseUrl) ?? []);
        return buildOpenAIModelList(configured, cfg.model);
    }

    /**
     * Force a (re)discovery from <baseUrl>/models, then return the freshly
     * built list + labels. The chat surface awaits this right after opening a
     * dialogue so the picker reflects the real server models even when the
     * discovery cache was empty (e.g. first session after a reload). When the
     * models are pinned in settings, discovery is skipped — the configured
     * list wins.
     */
    async refreshModels(force = false): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        if (!cfg.models.length && cfg.baseUrl) {
            // Skip network if file cache is fresh and not forced
            const cacheKey = `openai:${cfg.baseUrl}`;
            const stored = getCached(cacheKey);
            if (!force && stored && isFresh(stored)) {
                setDiscovered(cfg.baseUrl, stored.models, stored.labels ?? {}, stored.context);
            } else {
                await discoverModels(cfg, this.backend).catch(() => undefined);
            }
        }
        return { models: this.models(), labels: this.modelLabels() };
    }

    // Common OpenAI reasoning_effort values; "default" omits the param.
    reasoningLevels(): string[] {
        return ["default", "minimal", "low", "medium", "high"];
    }

    // No native plan tool over the raw API: inject one and parse a ```todo block.
    hasNativeTodo(): boolean { return false; }
    todoInjection(): string { return TODO_INJECTION; }
}
