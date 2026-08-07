import type { ShellExecutionMode } from "../aiTools/types";

/** OpenAI tool call as streamed/accumulated from chat completions deltas. */
export interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

/** OpenAI vision content part — a user message can mix text + images. */
export type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export type ChatMsg = {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content: string | null | ContentPart[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    /** Model id that produced this assistant message (kept across handoff). */
    model?: string;
};

export type ChatMessage = ChatMsg;

/** Token usage parsed from an OpenAI-compatible response (chat or responses). */
export interface ApiUsage {
    /** Prompt/input tokens reported by the provider for the last model request. */
    inputTokens: number;
    /** Completion/output tokens reported by the provider for the last model request. */
    outputTokens: number;
    /** Provider-reported total tokens, when available; otherwise the UI falls back to input + output. */
    totalTokens?: number;
    /** Internal reasoning tokens, when the provider exposes them as completion token details. */
    reasoningTokens?: number;
    /** Input tokens served from the provider-side prompt cache. */
    cacheRead: number;
    /** Effective model id returned by the gateway/provider after routing and fallback. */
    model?: string;
    /** Configured provider key that served the request. */
    providerKey?: string;
    /** Provider connector family that served the request, such as claude, codex, or openai. */
    providerType?: string;
    /** Model or preset id originally requested by the client before gateway routing. */
    requestedModel?: string;
    /** Total dispatch attempts made by the gateway for this request. */
    attempts?: number;
    /** Failed attempts before the successful fallback target, when any. */
    fallbackAttempts?: number;
    /** Gateway-side context compression diagnostics, when compression changed the outbound request. */
    compression?: {
        /** Approximate characters saved before dispatch. */
        savedChars?: number;
        /** Approximate characters before gateway compression. */
        originalChars?: number;
        /** Approximate characters after gateway compression. */
        compressedChars?: number;
        /** Messages truncated in place by the compressor. */
        truncatedMessages?: number;
        /** Historical messages removed from the live context. */
        removedMessages?: number;
        /** Historical tool calls pruned from assistant messages. */
        prunedToolCalls?: number;
        /** Historical tool results folded into summaries. */
        foldedToolResults?: number;
    };
    /** End-to-end duration of the last HTTP model call, measured locally. */
    durationMs?: number;
    /** Time from local request start until response headers/body became available. */
    ttfbMs?: number;
    /** Time from local request start until the first text/tool delta was observed. */
    firstDeltaMs?: number;
}

export interface OpenAIAdapterConfig {
    /** Detailed caller identity for gateway/activity diagnostics. */
    clientInfo?: { id: string; version: string; hostname: string; os: string };
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
    /**
     * Whether this gateway supports the OpenAI `developer` message role.
     * Built-in Sufficit AI handles this upstream; custom gateways may need the
     * prompt downgraded to `system`.
     */
    supportsDeveloperRole?: boolean;
    /** Max tool round-trips per turn before pausing (default 50). */
    maxToolHops?: number;
    /** Stop the turn after N tool steps with no assistant reply; 0/undefined = off. */
    noProgressStop?: number;
    /** Auto-compact the context when a prompt reaches this fraction of the window (0 = off). */
    autoCompactAt?: number;
    /**
     * Auto-compact the context the moment the last pending session task is
     * completed (task_complete/TaskUpdate reports zero remaining) — a natural
     * "unit of work is done" boundary, independent of the context-window
     * percentage that autoCompactAt tracks. Default true.
     */
    autoCompactOnTasksComplete?: boolean;
    /**
     * Sliding window: max conversation messages sent per request.
     * System/developer prefix and the first user turn are always preserved.
     * Default 40 (~20 turns). 0 = no trimming (old behaviour).
     */
    maxHistoryMessages?: number;
    /** How local shell tool execution is surfaced: silent, inline stream, or visible VS Code terminal. */
    shellExecution?: ShellExecutionMode;
    /**
     * Tells the model when it's resuming after a large real-world gap (e.g. the
     * user came back a day later) instead of leaving it to assume the
     * conversation is continuous. "never" | "5m" | "30m" | "2h" | "12h" — a
     * compact note is injected only when the gap since the last message meets
     * or exceeds this threshold. Default "5m".
     */
    timeGapNotice?: string;
    /** Unified permission mode default: "admin" (default) | "manager" | "user" | "plan". */
    permissionMode?: string;
    log?: (message: string) => void;
}
