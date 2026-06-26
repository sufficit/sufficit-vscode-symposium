/**
 * Unified message types for chat compression system.
 * Compatible with OpenAI ChatMessage format.
 */

export interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

export type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export interface Message {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content: string | null | ContentPart[] | Array<Record<string, unknown>>;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    model?: string;
}
