import { ApiUsage, ToolCall } from "./types";

export interface StreamTiming {
    requestStartedAt: number;
    responseStartedAt: number;
}

export interface ConsumeCallbacks {
    /** A streamed assistant text delta (the session adds model/label + emits). */
    onText: (delta: string) => void;
    /** A streamed error event from the provider. */
    onError: (message: string) => void;
    /** A transient, non-content status notice (e.g. "image transcribed"). Optional. */
    onStatusNotice?: (notice: string) => void;
}

/**
 * Reads an OpenAI-compatible SSE stream (chat-completions OR responses API),
 * emitting text deltas via `onText` and accumulating streamed tool_calls so the
 * caller can run them and continue. Returns the assembled assistant text, the
 * tool calls, an `aborted` flag (stream paused / transport dropped → partial
 * accumulation is still returned), and the final token usage when reported.
 *
 * Pure transport: no session state. Extracted from OpenAISession.consume.
 */
export async function consumeStream(
    stream: ReadableStream<Uint8Array>,
    m: string,
    timing: StreamTiming,
    responses: boolean,
    cb: ConsumeCallbacks,
): Promise<{ text: string; toolCalls: ToolCall[]; aborted: boolean; usage?: ApiUsage }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let assistant = "";
    let usage: ApiUsage | undefined;  // final token counts, when the API reports them
    let effectiveModel = m;
    let firstDeltaMs: number | undefined;
    const calls: ToolCall[] = []; // indexed by streamed tool_call index
    let lastFnIndex = 0;          // responses API: index of the most recent function_call
    const stampUsage = (u: ApiUsage): ApiUsage => ({
        ...u,
        model: u.model || effectiveModel,
        durationMs: Date.now() - timing.requestStartedAt,
        ttfbMs: timing.responseStartedAt - timing.requestStartedAt,
        firstDeltaMs,
    });
    const numberOrUndefined = (value: unknown): number | undefined => {
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
    };
    const stringOrUndefined = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim() ? value : undefined;
    const compressionOrUndefined = (value: unknown): ApiUsage["compression"] | undefined => {
        if (!value || typeof value !== "object") { return undefined; }
        const v = value as Record<string, unknown>;
        return {
            savedChars: numberOrUndefined(v.saved_chars),
            originalChars: numberOrUndefined(v.original_chars),
            compressedChars: numberOrUndefined(v.compressed_chars),
            truncatedMessages: numberOrUndefined(v.truncated_messages),
            removedMessages: numberOrUndefined(v.removed_messages),
            prunedToolCalls: numberOrUndefined(v.pruned_tool_calls),
            foldedToolResults: numberOrUndefined(v.folded_tool_results),
        };
    };
    const markDelta = () => {
        firstDeltaMs ??= Date.now() - timing.requestStartedAt;
    };
    const done = () => ({ text: assistant, toolCalls: calls.filter((c) => c && c.function.name), aborted: false, usage: usage ? stampUsage(usage) : undefined });
    try {
    for (; ;) {
        const r = await reader.read();
        if (r.done) { break; }
        buf += decoder.decode(r.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) { continue; }
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") { return done(); }
            try {
                const json = JSON.parse(payload);
                if (typeof json?.model === "string" && json.model) {
                    effectiveModel = json.model;
                }
                if (responses) {
                    const ty = json?.type;
                    if (typeof json?.response?.model === "string" && json.response.model) {
                        effectiveModel = json.response.model;
                    }
                    if (ty === "response.output_text.delta" && typeof json.delta === "string") {
                        markDelta();
                        assistant += json.delta; cb.onText(json.delta);
                    } else if (ty === "response.output_item.added" && json?.item?.type === "function_call") {
                        markDelta();
                        // New function call: index by output_index; carry call_id + name.
                        const i = json.output_index ?? calls.length;
                        calls[i] = { id: json.item.call_id ?? json.item.id ?? "", type: "function", function: { name: json.item.name ?? "", arguments: json.item.arguments ?? "" } };
                        lastFnIndex = i;
                    } else if (ty === "response.function_call_arguments.delta" && typeof json.delta === "string") {
                        markDelta();
                        const i = json.output_index ?? lastFnIndex;
                        if (calls[i]) { calls[i].function.arguments += json.delta; }
                    } else if (ty === "response.function_call_arguments.done" && typeof json.arguments === "string") {
                        markDelta();
                        // Some gateways send the full arguments only in the .done event (no deltas).
                        const i = json.output_index ?? lastFnIndex;
                        if (calls[i]) { calls[i].function.arguments = json.arguments; }
                    } else if (ty === "response.error") {
                        cb.onError(String(json?.error?.message ?? "response error"));
                    } else if ((ty === "response.completed" || ty === "response.incomplete") && json?.response?.usage) {
                        const u = json.response.usage;
                        // Gateway diagnostics are a non-standard extension grouped
                        // under `usage.gateway`; standard OpenAI clients ignore it.
                        const meta = u.gateway ?? json.response.gateway ?? json.gateway ?? {};
                        usage = {
                            inputTokens: Number(u.input_tokens ?? 0),
                            outputTokens: Number(u.output_tokens ?? 0),
                            totalTokens: numberOrUndefined(u.total_tokens),
                            reasoningTokens: numberOrUndefined(u.output_tokens_details?.reasoning_tokens),
                            cacheRead: Number(u.input_tokens_details?.cached_tokens ?? 0),
                            model: stringOrUndefined(meta.effective_model_id) || stringOrUndefined(json.response.model) || effectiveModel,
                            providerKey: stringOrUndefined(meta.provider_key),
                            providerType: stringOrUndefined(meta.provider_type),
                            requestedModel: stringOrUndefined(meta.requested_model),
                            attempts: numberOrUndefined(meta.attempts),
                            fallbackAttempts: numberOrUndefined(meta.fallback_attempts),
                            compression: compressionOrUndefined(meta.compression),
                        };
                    }
                    continue;
                }
                // Final usage chunk (stream_options.include_usage): choices is
                // empty and `usage` carries the turn's token totals.
                if (json?.usage) {
                    const u = json.usage;
                    // Gateway diagnostics are optional and ignored by standard
                    // OpenAI clients; Symposium uses them to explain routing,
                    // fallbacks, and server-side compression in the context menu.
                    const meta = u.gateway ?? json.gateway ?? {};
                    usage = {
                        inputTokens: Number(u.prompt_tokens ?? 0),
                        outputTokens: Number(u.completion_tokens ?? 0),
                        totalTokens: numberOrUndefined(u.total_tokens),
                        reasoningTokens: numberOrUndefined(u.completion_tokens_details?.reasoning_tokens),
                        cacheRead: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
                        model: stringOrUndefined(meta.effective_model_id) || effectiveModel,
                        providerKey: stringOrUndefined(meta.provider_key),
                        providerType: stringOrUndefined(meta.provider_type),
                        requestedModel: stringOrUndefined(meta.requested_model),
                        attempts: numberOrUndefined(meta.attempts),
                        fallbackAttempts: numberOrUndefined(meta.fallback_attempts),
                        compression: compressionOrUndefined(meta.compression),
                    };
                }
                const delta = json?.choices?.[0]?.delta;
                // Transient status notice (e.g. vision transcription annotation).
                // Not model output — surfaced separately, never added to `assistant`.
                if (typeof delta?.status_notice === "string" && delta.status_notice.trim()) {
                    cb.onStatusNotice?.(delta.status_notice.trim());
                }
                if (typeof delta?.content === "string" && delta.content) {
                    markDelta();
                    assistant += delta.content; cb.onText(delta.content);
                }
                // Accumulate tool_calls: name+id arrive first, arguments stream in chunks.
                for (const tc of delta?.tool_calls ?? []) {
                    markDelta();
                    const i = tc.index ?? 0;
                    if (!calls[i]) { calls[i] = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } }; }
                    if (tc.id) { calls[i].id = tc.id; }
                    if (tc.function?.name) { calls[i].function.name = tc.function.name; }
                    if (tc.function?.arguments) { calls[i].function.arguments += tc.function.arguments; }
                }
            } catch {
                // partial/non-JSON keepalive line; ignore
            }
        }
    }
    } catch (err) {
        // A paused/interrupted stream (AbortError or transport drop) must NOT
        // discard what we already received — return the partial accumulation
        // so the caller can persist the partial assistant turn and keep context.
        try { void reader.cancel(); } catch { /* ignore */ }
        return { text: assistant, toolCalls: calls.filter((c) => c && c.function.name), aborted: true };
    }
    return done();
}
