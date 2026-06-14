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
    /** Models offered in the picker. */
    models: string[];
    /** Custom headers (e.g. Authorization, x-api-key) for the sufficit-ai gateway. */
    headers: Record<string, string>;
    /** Convenience: if set and no Authorization header, sent as Bearer. */
    apiKey?: string;
    log?: (message: string) => void;
}

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
    readonly backend = "openai" as const;

    constructor(private readonly getConfig: () => OpenAIAdapterConfig) { }

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        const cfg = this.getConfig();
        if (!cfg.baseUrl) { return { ok: false, error: "set symposium.openai.baseUrl" }; }
        return { ok: true, version: cfg.baseUrl };
    }

    async listSessions(): Promise<SessionInfo[]> {
        return []; // stateless API: live sessions appear via the runtime registry
    }

    start(options: SessionStartOptions): AgentSession {
        return new OpenAISession(this.getConfig(), options);
    }

    models(): string[] {
        const cfg = this.getConfig();
        const list = cfg.models.length ? cfg.models : ["gpt-4o", "gpt-4o-mini"];
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
