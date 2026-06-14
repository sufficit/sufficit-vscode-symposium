import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import {
    AgentAdapter,
    AgentSession,
    SessionInfo,
    SessionStartOptions,
} from "./types";
import { TODO_INJECTION } from "./todos";

export interface OpenAIAdapterConfig {
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

// Discovered model ids per base URL (best-effort GET /models cache).
const discoveredModels = new Map<string, string[]>();

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * A direct OpenAI-compatible chat session (no CLI): streams /chat/completions
 * over HTTP with a custom base URL + headers, to talk straight to sufficit-ai
 * models. Stateless server-side, so the message history is kept here.
 */
class OpenAISession extends EventEmitter implements AgentSession {
    readonly backend = "openai" as const;
    readonly sessionId: string;
    private readonly messages: ChatMessage[] = [];
    private abort: AbortController | undefined;

    constructor(private readonly cfg: OpenAIAdapterConfig, private readonly options: SessionStartOptions) {
        super();
        this.sessionId = randomUUID();
        queueMicrotask(() => this.emit("event", { kind: "session", sessionId: this.sessionId, model: this.model() }));
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
        const url = this.cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
        const body: Record<string, unknown> = {
            model: this.model(),
            messages: this.messages,
            stream: true,
        };
        const effort = this.options.reasoning;
        if (effort && effort !== "default") { body.reasoning_effort = effort; }
        this.cfg.log?.(`[openai] POST ${url} model=${this.model()}`);
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
        this.emit("event", { kind: "turn-end" });
    }

    /** Reads an SSE stream of chat-completion chunks, emitting text deltas. */
    private async consume(stream: ReadableStream<Uint8Array>): Promise<string> {
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
                    const delta = json?.choices?.[0]?.delta?.content;
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
        return []; // stateless API: live sessions appear via the runtime registry
    }

    start(options: SessionStartOptions): AgentSession {
        return new OpenAISession(this.getConfig(), options);
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
        const list: string[] = (json?.data ?? json?.models ?? [])
            .map((m: any) => (typeof m === "string" ? m : m?.id ?? m?.name))
            .filter((x: any) => typeof x === "string");
        if (list.length) { discoveredModels.set(cfg.baseUrl, list); }
        cfg.log?.(`[${this.backend}] discovered ${list.length} models from ${url}`);
    }

    models(): string[] {
        const cfg = this.getConfig();
        const configured = cfg.models.length ? cfg.models : (discoveredModels.get(cfg.baseUrl) ?? []);
        const list = configured.length ? configured : ["gpt-4o", "gpt-4o-mini"];
        return [...new Set([cfg.model || list[0], ...list])];
    }

    // Common OpenAI reasoning_effort values; "default" omits the param.
    reasoningLevels(): string[] {
        return ["default", "minimal", "low", "medium", "high"];
    }

    // No native plan tool over the raw API: inject one and parse a ```todo block.
    hasNativeTodo(): boolean { return false; }
    todoInjection(): string { return TODO_INJECTION; }
}
