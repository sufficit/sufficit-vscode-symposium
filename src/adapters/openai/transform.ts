import { ChatMessage, ContentPart } from "./types";

/** Plain-text view of a message's content (drops image parts). */
export function contentText(content: string | null | ContentPart[]): string {
    if (typeof content === "string") { return content; }
    if (Array.isArray(content)) {
        return content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
    }
    return "";
}

/**
 * Converts the internal chat-shaped message log into Responses API `input`
 * items: plain messages stay {role,content}; an assistant tool turn becomes one
 * `function_call` item per call; a tool result becomes a `function_call_output`.
 */
export function toResponsesInput(messages: ChatMessage[]): unknown[] {
    const out: unknown[] = [];
    for (const m of messages) {
        if (m.role === "tool") {
            out.push({ type: "function_call_output", call_id: m.tool_call_id, output: contentText(m.content) });
            continue;
        }
        if (m.role === "assistant" && m.tool_calls?.length) {
            const t = contentText(m.content);
            if (t) { out.push({ role: "assistant", content: t }); }
            for (const tc of m.tool_calls) {
                out.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
            }
            continue;
        }
        if (Array.isArray(m.content)) {
            // Map vision parts to the Responses API shape (input_text/input_image).
            const parts = m.content.map((p) => p.type === "image_url"
                ? { type: "input_image", image_url: p.image_url.url }
                : { type: "input_text", text: p.text });
            out.push({ role: m.role, content: parts });
        } else {
            out.push({ role: m.role, content: m.content ?? "" });
        }
    }
    return out;
}
