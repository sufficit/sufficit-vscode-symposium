import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
} from "./types";
import { TODO_INJECTION } from "./todos";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

interface StoredSession {
    id: string;
    backend: string;
    title: string;
    cwd: string;
    model: string;
    updatedAt: string;
    messages: ChatMsg[];
}

/** Per-backend store dir for API-adapter transcripts (no CLI to persist them). */
function storeDir(backend: string): string {
    return path.join(os.homedir(), ".symposium", "sessions", backend);
}
function storePath(backend: string, id: string): string {
    return path.join(storeDir(backend), id + ".json");
}
function readStored(backend: string, id: string): StoredSession | undefined {
    try { return JSON.parse(fs.readFileSync(storePath(backend, id), "utf8")); } catch { return undefined; }
}
function writeStored(s: StoredSession): void {
    try {
        fs.mkdirSync(storeDir(s.backend), { recursive: true });
        fs.writeFileSync(storePath(s.backend, s.id), JSON.stringify(s));
    } catch { /* best-effort persistence */ }
}

export interface OpenAIAdapterConfig {
    /** Which API to call: chat completions or the Responses API. */
    api: "chat" | "responses";
    /** Base URL of an OpenAI-compatible API, e.g. https://api.sufficit-ai/v1 */
    baseUrl: string;
    /** Default model (empty = first of models). */
    model: string;
    /** Models offered in the picker (empty = auto-discover from /models). */
    models: string[];
    /** Custom headers (e.g. Authorization, x-api-key) for the sufficit-ai gateway. */
    headers: Record<string, string>;
    /** Convenience: if set and no Authorization header, sent as Bearer. */
    apiKey?: string;
    log?: (message: string) => void;
}

// Discovered model ids and id→friendly-name per base URL (GET /models cache).
const discoveredModels = new Map<string, string[]>();
const discoveredLabels = new Map<string, Record<string, string>>();

type ChatMessage = ChatMsg;

/**
 * A direct OpenAI-compatible chat session (no CLI): streams /chat/completions
 * over HTTP with a custom base URL + headers, to talk straight to sufficit-ai
 * models. Stateless server-side, so history is kept here and persisted to disk
 * so the session survives a reload (the API has no transcript of its own).
 */
class OpenAISession extends EventEmitter implements AgentSession {
    readonly sessionId: string;
    private readonly messages: ChatMessage[] = [];
    private abort: AbortController | undefined;
    private title = "";

    constructor(
        readonly backend: string,
        private readonly cfg: OpenAIAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        // Resume a stored session if asked, else start a fresh one.
        const resumed = options.resumeSessionId ? readStored(backend, options.resumeSessionId) : undefined;
        this.sessionId = resumed?.id ?? randomUUID();
        if (resumed) { this.messages.push(...resumed.messages); this.title = resumed.title; }
        queueMicrotask(() => this.emit("event", { kind: "session", sessionId: this.sessionId, model: this.model() }));
    }

    private persist(): void {
        writeStored({
            id: this.sessionId, backend: this.backend, title: this.title,
            cwd: this.options.cwd, model: this.model(), updatedAt: new Date().toISOString(),
            messages: this.messages,
        });
    }

    private model(): string {
        return this.options.model || this.cfg.model || this.cfg.models[0] || "gpt-4o-mini";
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = { "content-type": "application/json", ...this.cfg.headers };
        if (this.cfg.apiKey && !Object.keys(h).some((k) => k.toLowerCase() === "authorization")) {
            h["authorization"] = `Bearer ${this.cfg.apiKey}`;
        }
        return h;
    }

    send(text: string): void {
        this.messages.push({ role: "user", content: text });
        if (!this.title) { this.title = text.trim().slice(0, 60); }
        this.persist();
        void this.run();
    }

    cancel(): void {
        this.abort?.abort();
    }

    dispose(): void {
        this.abort?.abort();
    }

    private async run(): Promise<void> {
        this.abort = new AbortController();
        const responses = this.cfg.api === "responses";
        const base = this.cfg.baseUrl.replace(/\/+$/, "");
        const url = base + (responses ? "/responses" : "/chat/completions");
        const effort = this.options.reasoning;
        const body: Record<string, unknown> = responses
            ? { model: this.model(), input: this.messages, stream: true }
            : { model: this.model(), messages: this.messages, stream: true };
        if (effort && effort !== "default") {
            if (responses) { body.reasoning = { effort }; }
            else { body.reasoning_effort = effort; }
        }
        this.cfg.log?.(`[${this.backend}] POST ${url} api=${this.cfg.api} model=${this.model()}`);
        let assistant = "";
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify(body),
                signal: this.abort.signal,
            });
            if (!res.ok || !res.body) {
                const detail = await res.text().catch(() => "");
                this.emit("event", { kind: "error", message: `HTTP ${res.status} ${res.statusText} ${detail}`.trim() });
                this.emit("event", { kind: "turn-end" });
                return;
            }
            assistant = await this.consume(res.body);
        } catch (error) {
            if ((error as any)?.name !== "AbortError") {
                this.emit("event", { kind: "error", message: error instanceof Error ? error.message : String(error) });
            }
        }
        if (assistant) { this.messages.push({ role: "assistant", content: assistant }); }
        this.persist();
        this.emit("event", { kind: "turn-end" });
    }

    /** Reads an SSE stream, emitting text deltas for chat or responses shape. */
    private async consume(stream: ReadableStream<Uint8Array>): Promise<string> {
        const responses = this.cfg.api === "responses";
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let assistant = "";
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) { break; }
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith("data:")) { continue; }
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") { return assistant; }
                try {
                    const json = JSON.parse(payload);
                    let delta: unknown;
                    if (responses) {
                        // Responses API: streamed as response.output_text.delta events.
                        if (json?.type === "response.output_text.delta") { delta = json.delta; }
                        else if (json?.type === "response.error") { this.emit("event", { kind: "error", message: String(json?.error?.message ?? "response error") }); }
                    } else {
                        delta = json?.choices?.[0]?.delta?.content;
                    }
                    if (typeof delta === "string" && delta) {
                        assistant += delta;
                        this.emit("event", { kind: "text", text: delta });
                    }
                } catch {
                    // partial/non-JSON keepalive line; ignore
                }
            }
        }
        return assistant;
    }
}

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
                out.push({ backend: this.backend, sessionId: s.id, title: s.title || "Session", cwd: s.cwd, updatedAt: new Date(s.updatedAt) });
            }
        }
        return out;
    }

    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        const s = readStored(this.backend, info.sessionId);
        if (!s) { return []; }
        return s.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role as "user" | "assistant", text: m.content }));
    }

    async deleteSession(info: SessionInfo): Promise<void> {
        try { fs.rmSync(storePath(this.backend, info.sessionId), { force: true }); } catch { /* ignore */ }
    }

    start(options: SessionStartOptions): AgentSession {
        return new OpenAISession(this.backend, this.getConfig(), options);
    }

    /** GET <baseUrl>/models → cache the offered model ids (OpenAI shape). */
    private async discoverModels(cfg: OpenAIAdapterConfig): Promise<void> {
        const url = cfg.baseUrl.replace(/\/+$/, "") + "/models";
        const headers: Record<string, string> = { ...cfg.headers };
        if (cfg.apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
            headers["authorization"] = `Bearer ${cfg.apiKey}`;
        }
        const res = await fetch(url, { headers });
        if (!res.ok) { return; }
        const json: any = await res.json();
        const raw: any[] = json?.data ?? json?.models ?? [];
        const list: string[] = [];
        const labels: Record<string, string> = {};
        for (const m of raw) {
            const id = typeof m === "string" ? m : m?.id ?? m?.name;
            if (typeof id !== "string") { continue; }
            list.push(id);
            const name = typeof m === "object" ? (m?.name ?? m?.title) : undefined;
            if (typeof name === "string" && name && name !== id) { labels[id] = name; }
        }
        if (list.length) { discoveredModels.set(cfg.baseUrl, list); discoveredLabels.set(cfg.baseUrl, labels); }
        cfg.log?.(`[${this.backend}] discovered ${list.length} models from ${url}`);
    }

    /** Friendly id→name labels for the model picker (from discovery). */
    modelLabels(): Record<string, string> {
        return discoveredLabels.get(this.getConfig().baseUrl) ?? {};
    }

    models(): string[] {
        const cfg = this.getConfig();
        const configured = cfg.models.length ? cfg.models : (discoveredModels.get(cfg.baseUrl) ?? []);
        const list = configured.length ? configured : ["gpt-4o", "gpt-4o-mini"];
        return [...new Set([cfg.model || list[0], ...list])];
    }

    /**
     * Force a (re)discovery from <baseUrl>/models, then return the freshly
     * built list + labels. The chat surface awaits this right after opening a
     * dialogue so the picker reflects the real server models even when the
     * discovery cache was empty (e.g. first session after a reload). When the
     * models are pinned in settings, discovery is skipped — the configured
     * list wins.
     */
    async refreshModels(): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        if (!cfg.models.length && cfg.baseUrl) {
            await this.discoverModels(cfg).catch(() => undefined);
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
