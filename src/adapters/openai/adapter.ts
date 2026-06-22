import * as fs from "fs";
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
import { getCached, setCached, isFresh } from "../modelCache";
import { OpenAIAdapterConfig } from "./types";
import { readStored, storeDir, storePath } from "./store";
import { contentText } from "./transform";
import {
    getDiscoveredLabels, getDiscoveredModels, hasDiscoveredModels,
    modelContextLength, setDiscovered,
} from "./models";
import { friendlyToolDetail, toolPath } from "./toolDetail";
import { historyFromLedger, ledgerWasCompacted } from "./history";
import { getOpenAITokenProvider } from "./token";
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
        await this.discoverModels(cfg).catch(() => undefined);
        return { ok: true, version: cfg.baseUrl };
    }

    async listSessions(): Promise<SessionInfo[]> {
        const dir = storeDir(this.backend);
        let files: string[];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
        const out: SessionInfo[] = [];
        for (const f of files) {
            const s = readStored(this.backend, f.slice(0, -5));
            if (s) {
                out.push({ backend: this.backend, sessionId: s.id, title: s.title || "Session", cwd: s.cwd, updatedAt: new Date(s.updatedAt), model: s.model });
            }
        }
        return out;
    }

    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        // Compacted sessions: the store holds only the summarized model context.
        // The lossless human transcript lives in the ledger — show that so the
        // chat still mirrors the full conversation (the model sees the summary).
        if (ledger.hasLedger(info.sessionId) && ledgerWasCompacted(info.sessionId)) {
            return historyFromLedger(info.sessionId);
        }
        const s = readStored(this.backend, info.sessionId);
        if (!s) { return []; }
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
        return out;
    }

    async deleteSession(info: SessionInfo): Promise<void> {
        try { fs.rmSync(storePath(this.backend, info.sessionId), { force: true }); } catch { /* ignore */ }
    }

    start(options: SessionStartOptions): AgentSession {
        return new OpenAISession(this.backend, this.getConfig(), options);
    }

    /** API backend: takes one-shot app instructions as developer messages. */
    roleAware(): boolean { return true; }

    /** Slash commands offered for this backend. `/compact` is intercepted locally
     *  (summarize + shrink the model context); it also re-enables the context
     *  popover's "Compact Conversation" button (gated on a `compact` command). */
    async commands(): Promise<SlashCommand[]> {
        return [{ name: "compact", description: "Summarize older turns to shrink the model context (full history is preserved)", kind: "builtin" }];
    }

    /**
     * Accept inlined images (vision): attached/pasted images are sent as
     * image_url content parts so a vision-capable model sees them directly,
     * instead of being handed a file path it reads as binary. The gateway must
     * route to a vision-capable model for the image to be interpreted.
     */
    supportsImages(): boolean { return true; }

    /** GET <baseUrl>/models → cache the offered model ids (OpenAI shape). */
    private async discoverModels(cfg: OpenAIAdapterConfig): Promise<void> {
        const url = cfg.baseUrl.replace(/\/+$/, "") + "/models";
        const headers: Record<string, string> = { ...cfg.headers };
        if (cfg.clientInfo) {
            headers["x-client-id"] = cfg.clientInfo.id;
            headers["x-client-version"] = cfg.clientInfo.version;
            headers["x-client-hostname"] = cfg.clientInfo.hostname;
            headers["x-client-os"] = cfg.clientInfo.os;
            headers["user-agent"] = `${cfg.clientInfo.id}/${cfg.clientInfo.version} (${cfg.clientInfo.os}; ${cfg.clientInfo.hostname})`;
        }
        const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
        if (!hasAuth && cfg.apiKey) {
            headers["authorization"] = `Bearer ${cfg.apiKey}`;
        } else if (!hasAuth) {
            const provider = getOpenAITokenProvider();
            if (provider) {
                const t = await provider().catch(() => null);
                if (t) { headers["authorization"] = `Bearer ${t}`; }
            }
        }
        const res = await fetch(url, { headers });
        if (!res.ok) { return; }
        const json: any = await res.json();
        const raw: any[] = json?.data ?? json?.models ?? [];
        const list: string[] = [];
        const labels: Record<string, string> = {};
        const context: Record<string, number> = {};
        for (const m of raw) {
            const id = typeof m === "string" ? m : m?.id ?? m?.name;
            if (typeof id !== "string") { continue; }
            list.push(id);
            const name = typeof m === "object" ? (m?.name ?? m?.title) : undefined;
            if (typeof name === "string" && name && name !== id) { labels[id] = name; }
            const ctx = modelContextLength(m);
            if (ctx) { context[id] = ctx; }
        }
        if (list.length) {
            setDiscovered(cfg.baseUrl, list, labels, context);
            const cacheKey = `openai:${cfg.baseUrl}`;
            setCached(cacheKey, { models: list, labels, lastUpdate: new Date().toISOString() });
        }
        cfg.log?.(`[${this.backend}] discovered ${list.length} models from ${url}`);
    }

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
                setDiscovered(cfg.baseUrl, stored.models, stored.labels ?? {});
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
                setDiscovered(cfg.baseUrl, stored.models, stored.labels ?? {});
            } else {
                await this.discoverModels(cfg).catch(() => undefined);
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
