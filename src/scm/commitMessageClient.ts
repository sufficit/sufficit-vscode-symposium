const REQUEST_TIMEOUT_MS = 60_000;

type FetchImplementation = typeof fetch;

interface CommitMessageRequestOptions {
    fetchImpl?: FetchImplementation;
    timeoutMs?: number;
}

interface OpenAIMessage {
    content?: unknown;
    tool_calls?: unknown[];
}

interface OpenAIChoice {
    message?: OpenAIMessage;
    finish_reason?: unknown;
}

interface ChatPayload {
    choices?: OpenAIChoice[];
    message?: { content?: unknown };
    error?: unknown;
}

export interface CommitMessageResult {
    message: string;
    protocol: "openai" | "ollama";
    status: number;
    finishReason?: string;
}

export class CommitMessageClientError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly responseShape?: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "CommitMessageClientError";
    }
}

/**
 * Uses the gateway's OpenAI route because it supports `tool_choice: "none"`.
 * The Ollama VS Code route injects editor tools even for a tool-less request,
 * which can turn a simple text task into an unusable tool call.
 */
export async function requestCommitMessage(
    gatewayUrl: string,
    model: string,
    system: string,
    user: string,
    options: CommitMessageRequestOptions = {},
): Promise<CommitMessageResult> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const endpoint = `${gatewayUrl.replace(/\/+$/, "")}/v1/chat/completions`;

    let response: Response;
    try {
        response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
                model,
                stream: false,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                temperature: 0.2,
                tool_choice: "none",
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (isAbortError(error)) {
            throw new CommitMessageClientError(
                `AI gateway timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
                undefined,
                undefined,
                { cause: error },
            );
        }
        throw new CommitMessageClientError(
            `Could not contact the AI gateway: ${errorMessage(error)}`,
            undefined,
            undefined,
            { cause: error },
        );
    }

    const raw = await response.text();
    const payload = parsePayload(raw, response.status);
    const shape = describeShape(payload);

    if (!response.ok) {
        const detail = extractGatewayError(payload);
        throw new CommitMessageClientError(
            `AI gateway returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
            response.status,
            shape,
        );
    }

    const extracted = extractMessage(payload);
    if (extracted?.message) {
        return {
            message: cleanupCommitMessage(extracted.message),
            protocol: extracted.protocol,
            status: response.status,
            finishReason: extracted.finishReason,
        };
    }

    const choice = payload.choices?.[0];
    if ((choice?.message?.tool_calls?.length ?? 0) > 0) {
        throw new CommitMessageClientError(
            "AI gateway returned tool calls instead of commit text despite tool_choice=none.",
            response.status,
            shape,
        );
    }

    const detail = extractGatewayError(payload);
    throw new CommitMessageClientError(
        detail
            ? `AI gateway returned no commit text: ${detail}`
            : `AI gateway returned an empty or incompatible response (${shape}).`,
        response.status,
        shape,
    );
}

function parsePayload(raw: string, status: number): ChatPayload {
    if (!raw.trim()) {
        throw new CommitMessageClientError(
            `AI gateway returned an empty HTTP ${status} response.`,
            status,
            "empty body",
        );
    }

    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("top-level JSON value is not an object");
        }
        return value as ChatPayload;
    } catch (error) {
        throw new CommitMessageClientError(
            `AI gateway returned invalid JSON (HTTP ${status}).`,
            status,
            "invalid JSON",
            { cause: error },
        );
    }
}

function extractMessage(
    payload: ChatPayload,
): { message: string; protocol: "openai" | "ollama"; finishReason?: string } | undefined {
    const choice = payload.choices?.[0];
    const openAIContent = textContent(choice?.message?.content);
    if (openAIContent.trim()) {
        return {
            message: openAIContent,
            protocol: "openai",
            finishReason:
                typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
        };
    }

    // Compatibility only: a proxy may preserve the Ollama envelope even on
    // the OpenAI route. Accept its text, but report the protocol to diagnostics.
    const ollamaContent = textContent(payload.message?.content);
    if (ollamaContent.trim()) {
        return { message: ollamaContent, protocol: "ollama" };
    }

    return undefined;
}

function textContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((part) => {
            if (!part || typeof part !== "object") {
                return "";
            }
            const item = part as { type?: unknown; text?: unknown };
            return (item.type === "text" || item.type === "output_text") &&
                typeof item.text === "string"
                ? item.text
                : "";
        })
        .filter(Boolean)
        .join("\n");
}

function extractGatewayError(payload: ChatPayload): string {
    const error = payload.error;
    if (typeof error === "string") {
        return error.slice(0, 300);
    }
    if (!error || typeof error !== "object") {
        return "";
    }

    const value = error as { message?: unknown; detail?: unknown };
    const detail =
        typeof value.message === "string"
            ? value.message
            : typeof value.detail === "string"
              ? value.detail
              : "";
    return detail.slice(0, 300);
}

function describeShape(payload: ChatPayload): string {
    const keys = Object.keys(payload).sort();
    const choiceCount = Array.isArray(payload.choices) ? payload.choices.length : 0;
    const hasOllamaMessage = !!payload.message;
    return `keys=${keys.join(",") || "(none)"}; choices=${choiceCount}; ollamaMessage=${hasOllamaMessage}`;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Strips wrapping code fences / quotes the model may add. */
export function cleanupCommitMessage(raw: string): string {
    let value = raw.trim();
    const fence = value.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
    if (fence) {
        value = fence[1].trim();
    }
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).trim();
    }
    return value;
}
