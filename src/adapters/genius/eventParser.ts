import type { AgentEvent } from "../types";

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as RecordValue)
        : {};
}

function string(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface GeniusParserCallbacks {
    session(id: string, presetId?: string): void;
    emit(event: AgentEvent): void;
}

/** Converts Genius CLI schemaVersion 1 JSONL into Symposium's live event contract. */
export class GeniusEventParser {
    private readonly parts = new Map<string, string>();
    private readonly tools = new Map<string, string>();
    private streamedText = false;
    sawResult = false;
    sawError = false;

    constructor(private readonly callbacks: GeniusParserCallbacks) {}

    handleLine(line: string): void {
        if (!line.trim()) return;
        let frame: RecordValue;
        try {
            frame = object(JSON.parse(line));
        } catch {
            throw new Error("Genius CLI emitted invalid JSONL");
        }
        if (frame.schemaVersion !== 1) {
            throw new Error(
                `Unsupported Genius CLI protocol version: ${String(frame.schemaVersion)}`,
            );
        }
        switch (frame.type) {
            case "session": {
                const id = string(frame.sessionId);
                if (!id) throw new Error("Genius CLI session record has no sessionId");
                this.callbacks.session(id, string(frame.presetId));
                break;
            }
            case "event":
                this.handleAction(string(frame.actionType), object(frame.action));
                break;
            case "result":
                this.sawResult = true;
                if (frame.status === "failed") {
                    this.error(string(frame.error) || "Genius turn failed");
                } else if (frame.status === "completed") {
                    const answer = string(frame.answer);
                    if (!this.streamedText && answer)
                        this.callbacks.emit({ kind: "text", text: answer });
                } else {
                    this.error("Genius CLI returned an unknown result status");
                }
                break;
            case "error": {
                const data = object(frame.data);
                const message = string(frame.error) || "Genius CLI command failed";
                this.error(
                    data.code === "session_not_found"
                        ? `${message}. This session was removed from Genius; start a new chat.`
                        : message,
                );
                break;
            }
        }
    }

    private handleAction(type: string | undefined, action: RecordValue): void {
        const partId = string(action.partId);
        if (type === "chat/responsePart" && partId) {
            const kind = string(action.kind);
            if (kind) this.parts.set(partId, kind);
            return;
        }
        if (type === "chat/delta" && partId) {
            const content = string(action.content);
            if (!content) return;
            switch (this.parts.get(partId)) {
                case "Markdown":
                    if (partId.endsWith("-failure")) return;
                    this.streamedText = true;
                    this.callbacks.emit({ kind: "text", text: content });
                    break;
                case "ToolCall":
                    this.handleTool(partId, content);
                    break;
            }
            return;
        }
        if (type === "chat/reasoning") {
            const content = string(action.content);
            if (content) this.callbacks.emit({ kind: "thinking", text: content });
            return;
        }
        if (type === "chat/usage") {
            const usage = object(action.usage);
            this.callbacks.emit({
                kind: "usage",
                inputTokens: number(usage.inputTokens),
                outputTokens: number(usage.outputTokens),
                reasoningTokens: number(usage.reasoningTokens),
                cacheRead: number(usage.cachedTokens),
            });
        }
    }

    private handleTool(partId: string, content: string): void {
        const existing = this.tools.get(partId);
        if (existing) {
            if (content.startsWith(" → ")) {
                this.callbacks.emit({
                    kind: "tool-end",
                    toolName: existing,
                    toolId: partId,
                    result: content.slice(3),
                });
            } else {
                this.callbacks.emit({ kind: "tool-output", toolId: partId, text: content });
            }
            return;
        }
        const match = /^([^()\s]+)\((.*)\)$/s.exec(content);
        const name = match?.[1] ?? "Genius tool";
        this.tools.set(partId, name);
        this.callbacks.emit({
            kind: "tool-start",
            toolName: name,
            toolId: partId,
            input: match?.[2] ?? content,
        });
    }

    private error(message: string): void {
        this.sawError = true;
        this.callbacks.emit({ kind: "error", message, retryable: false });
    }
}
