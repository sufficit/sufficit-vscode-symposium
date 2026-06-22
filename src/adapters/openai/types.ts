import { ShellExecutionMode } from "../aiTools";

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
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
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
     * Sliding window: max conversation messages sent per request.
     * System/developer prefix and the first user turn are always preserved.
     * Default 40 (~20 turns). 0 = no trimming (old behaviour).
     */
    maxHistoryMessages?: number;
    /** How local shell tool execution is surfaced: silent, inline stream, or visible VS Code terminal. */
    shellExecution?: ShellExecutionMode;
    log?: (message: string) => void;
}
