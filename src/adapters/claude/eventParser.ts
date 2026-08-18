import { snapshots } from "../../snapshots";
import {
    contextWindowFor,
    diffCounts,
    editDiff,
    extractTodos,
    prettyJson,
    summarizeToolInput,
    toolFilePath,
    toolResultText,
} from "../parse";
import type { AgentEvent } from "../types";
import { ClaudeTaskTracker } from "./tasks";
import { parseClaudeQuota } from "./usage";

interface ParserDeps {
    model: () => string | undefined;
    reasoning: () => string | undefined;
    getSessionId: () => string | undefined;
    setSessionId: (id: string) => void;
    setTurnActive: (active: boolean) => void;
    emit: (event: AgentEvent) => void;
}

export class ClaudeEventParser {
    private streamedText = false;
    private streamedThinking = false;
    private pendingToolIds = new Set<string>();
    private deferredTurnEnd: { costUsd?: number; durationMs?: number } | undefined;
    private readonly tasks = new ClaudeTaskTracker();

    constructor(private readonly deps: ParserDeps) {}

    resetPending(): void {
        this.pendingToolIds.clear();
        this.deferredTurnEnd = undefined;
    }

    handleLine(line: string, sourceCancelled = false): void {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        const quota = parseClaudeQuota(event, "claude");
        if (quota) this.deps.emit({ kind: "quota", ...quota });
        if (event.type === "stream_event") this.handleStream(event);
        else if (event.type === "system") this.handleSystem(event);
        else if (event.type === "assistant") this.handleAssistant(event);
        else if (event.type === "user") this.handleUser(event);
        else if (event.type === "result") this.handleResult(event, sourceCancelled);
    }

    private handleStream(event: Record<string, unknown>): void {
        const stream = record(event.event);
        if (stream?.type !== "content_block_delta") return;
        const delta = record(stream.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
            this.streamedText = true;
            this.deps.emit({
                kind: "text",
                text: delta.text,
                model: this.deps.model(),
                reasoning: this.deps.reasoning(),
            });
        } else if (
            delta?.type === "thinking_delta" &&
            typeof delta.thinking === "string" &&
            delta.thinking.trim()
        ) {
            this.streamedThinking = true;
            this.deps.emit({ kind: "thinking", text: delta.thinking });
        }
    }

    private handleSystem(event: Record<string, unknown>): void {
        if (event.subtype !== "init" || typeof event.session_id !== "string") return;
        this.deps.setSessionId(event.session_id);
        this.deps.emit({
            kind: "session",
            sessionId: event.session_id,
            model: typeof event.model === "string" ? event.model : undefined,
        });
    }

    private handleAssistant(event: Record<string, unknown>): void {
        const content = record(event.message)?.content;
        for (const raw of Array.isArray(content) ? content : []) {
            const block = record(raw);
            if (!block) continue;
            if (block.type === "thinking" && typeof block.thinking === "string") {
                if (!this.streamedThinking && block.thinking.trim()) {
                    this.deps.emit({ kind: "thinking", text: block.thinking });
                }
            } else if (block.type === "text" && typeof block.text === "string") {
                if (!this.streamedText) {
                    this.deps.emit({
                        kind: "text",
                        text: block.text,
                        model: this.deps.model(),
                        reasoning: this.deps.reasoning(),
                    });
                }
            } else if (block.type === "tool_use") {
                this.handleToolUse(block);
            }
        }
    }

    private handleToolUse(block: Record<string, unknown>): void {
        if (typeof block.id === "string") this.pendingToolIds.add(block.id);
        const name = String(block.name);
        const counts = diffCounts(name, block.input);
        const filePath = toolFilePath(block.input);
        const sessionId = this.deps.getSessionId();
        if (counts && filePath && sessionId) snapshots.capture(sessionId, filePath);
        this.deps.emit({
            kind: "tool-start",
            toolName: name,
            detail: summarizeToolInput(block.input),
            toolId: typeof block.id === "string" ? block.id : undefined,
            input: prettyJson(block.input),
            added: counts?.added,
            removed: counts?.removed,
            todos:
                extractTodos(name, block.input) ??
                this.tasks.observeToolUse(
                    name,
                    block.input,
                    typeof block.id === "string" ? block.id : undefined,
                ),
            path: filePath,
            diff: editDiff(name, block.input),
        });
    }

    private handleUser(event: Record<string, unknown>): void {
        const content = record(event.message)?.content;
        for (const raw of Array.isArray(content) ? content : []) {
            const block = record(raw);
            if (block?.type !== "tool_result") continue;
            const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
            if (id) this.pendingToolIds.delete(id);
            this.deps.emit({
                kind: "tool-end",
                toolName: id ?? "tool",
                toolId: id,
                result: toolResultText(block.content),
                todos: this.tasks.observeToolResult(id, event.toolUseResult),
            });
        }
        if (this.deferredTurnEnd && this.pendingToolIds.size === 0) {
            this.deps.setTurnActive(false);
            this.deps.emit({ kind: "turn-end", ...this.deferredTurnEnd });
            this.deferredTurnEnd = undefined;
        }
    }

    private handleResult(event: Record<string, unknown>, sourceCancelled: boolean): void {
        if (typeof event.session_id === "string") this.deps.setSessionId(event.session_id);
        this.streamedText = false;
        this.streamedThinking = false;
        if (event.is_error && !sourceCancelled) {
            this.deps.emit({ kind: "error", message: resultError(event) });
        }
        const usage = record(event.usage) ?? record(record(event.message)?.usage);
        if (usage) this.emitUsage(usage);
        const end = {
            costUsd: optionalNumber(event.total_cost_usd),
            durationMs: optionalNumber(event.duration_ms),
        };
        if (this.pendingToolIds.size > 0) {
            this.deferredTurnEnd = end;
        } else {
            this.deps.setTurnActive(false);
            this.deps.emit({ kind: "turn-end", ...end });
        }
    }

    private emitUsage(usage: Record<string, unknown>): void {
        const cacheRead =
            number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens);
        this.deps.emit({
            kind: "usage",
            inputTokens: number(usage.input_tokens) + cacheRead,
            outputTokens: number(usage.output_tokens),
            cacheRead,
            contextWindow: contextWindowFor(this.deps.model() ?? ""),
        });
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function number(value: unknown): number {
    return typeof value === "number" ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function resultError(event: Record<string, unknown>): string {
    return typeof event.result === "string"
        ? event.result
        : typeof event.subtype === "string"
          ? event.subtype
          : "unknown error";
}
