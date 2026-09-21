import { parseCodexUsage } from "../parse";
import { parseAdapterQuota } from "../quota";
import { parseNativeTodos } from "../todos";
import { isTransientErrorMessage } from "../transientError";
import type { AgentEvent } from "../types";
import { codexUsage } from "./usage";
import {
    codexItemId,
    codexItemText,
    codexItemType,
    codexToolEnd,
    codexToolStart,
} from "./itemParser";

interface ParserDeps {
    /** Effective model for the live turn ("" until the backend reports one). */
    model: () => string;
    setModel: (model: string) => void;
    reasoning: () => string | undefined;
    getSessionId: () => string | undefined;
    setSessionId: (id: string) => void;
    /** True while the current child is being killed on purpose (errors are noise). */
    isCancelled: () => boolean;
    /** Marks this turn as having already surfaced an error to the user. */
    setReportedError: () => void;
    /** Context window of the configured model, used when Codex reports none. */
    configuredContextWindow: () => number;
    emit: (event: AgentEvent) => void;
    emitTurnEnd: () => void;
}

/**
 * Translates one `codex exec --json` JSONL line into normalized AgentEvents.
 * Holds only the parsing state that spans lines of a turn; process/lifecycle
 * state stays on {@link CodexSession} and is reached through {@link ParserDeps}.
 */
export class CodexEventParser {
    private lastContextWindow: number | undefined;
    private pendingAgentMessage: string | undefined;
    private readonly startedTools = new Set<string>();

    constructor(private readonly deps: ParserDeps) {}

    beginTurn(): void {
        this.pendingAgentMessage = undefined;
        this.startedTools.clear();
    }

    flushPendingMessage(kind: "text" | "thinking"): void {
        const text = this.pendingAgentMessage;
        this.pendingAgentMessage = undefined;
        if (!text) return;
        if (kind === "thinking") {
            this.deps.emit({ kind, text });
        } else {
            this.deps.emit({
                kind,
                text,
                model: this.deps.model() || undefined,
                reasoning: this.deps.reasoning(),
            });
        }
    }

    handleLine(line: string): void {
        if (!line.trim()) {
            return;
        }
        let event: { type: string; [key: string]: unknown };
        try {
            event = JSON.parse(line);
        } catch {
            return; // non-JSON log lines (codex prints some ERROR lines plainly)
        }
        const quota = parseAdapterQuota(event, "codex");
        if (quota) {
            codexUsage.observe(quota);
            this.deps.emit({ kind: "quota", ...quota });
        }
        const payload =
            typeof event.payload === "object" && event.payload !== null
                ? (event.payload as Record<string, unknown>)
                : undefined;
        if (
            event.type === "token_count" ||
            (event.type === "event_msg" && payload?.type === "token_count")
        ) {
            this.emitUsage(event);
        }
        switch (event.type) {
            case "thread.started":
                if (typeof event.thread_id === "string" && !this.deps.getSessionId()) {
                    this.deps.setSessionId(event.thread_id);
                    this.deps.emit({
                        kind: "session",
                        sessionId: event.thread_id,
                        model: this.deps.model() || undefined,
                    });
                }
                break;
            case "item.started":
            case "item.completed":
                this.handleItem(event);
                break;
            case "turn_context":
                this.handleTurnContext(event);
                break;
            case "turn.completed":
                this.flushPendingMessage("text");
                // turn.completed may carry { usage: {...} }. Emit usage (if any)
                // BEFORE turn-end so the meter reflects the final totals.
                this.emitUsage(event);
                this.deps.emitTurnEnd();
                break;
            case "turn.failed":
                this.flushPendingMessage("thinking");
                this.handleTurnFailed(event);
                break;
            case "error":
                this.handleError(event);
                break;
        }
    }

    private handleItem(event: { type: string; [key: string]: unknown }): void {
        const item =
            typeof event.item === "object" && event.item !== null
                ? (event.item as Record<string, unknown>)
                : {};
        const itemType = codexItemType(item);
        // Codex's plan/todo updates (e.g. update_plan / todo_list).
        const todos = parseNativeTodos(itemType ?? "", item);
        if (todos) {
            this.flushPendingMessage("thinking");
            this.deps.emit({
                kind: "tool-start",
                toolName: "TodoWrite",
                detail: "",
                todos,
            });
            return;
        }
        if (itemType === "agent_message" && event.type === "item.completed") {
            const text = codexItemText(item);
            if (!text) return;
            // `codex exec --json` omits the app-server `phase` field. Hold one
            // message so a following tool can classify it as public progress,
            // while the last message of the turn remains the final answer.
            this.flushPendingMessage("thinking");
            this.pendingAgentMessage = text;
            return;
        }
        if (itemType === "reasoning" && event.type === "item.completed") {
            this.flushPendingMessage("thinking");
            const text = codexItemText(item);
            if (text) this.deps.emit({ kind: "thinking", text });
            return;
        }
        const start = codexToolStart(item);
        const end = event.type === "item.completed" ? codexToolEnd(item) : undefined;
        if (!start && !end) return;
        this.flushPendingMessage("thinking");
        const id = codexItemId(item);
        const toolKey =
            id ??
            `${itemType ?? "tool"}:${start?.toolName ?? end?.toolName}:${start?.detail ?? end?.detail ?? ""}`;
        if (start && (event.type !== "item.completed" || !this.startedTools.has(toolKey))) {
            this.deps.emit(start);
            this.startedTools.add(toolKey);
        }
        if (end) {
            this.deps.emit(end);
            this.startedTools.delete(toolKey);
        }
    }

    private handleTurnContext(event: { type: string; [key: string]: unknown }): void {
        const payload =
            typeof event.payload === "object" && event.payload !== null
                ? (event.payload as Record<string, unknown>)
                : {};
        if (
            typeof payload.model === "string" &&
            payload.model &&
            payload.model !== this.deps.model()
        ) {
            this.deps.setModel(payload.model);
            this.deps.emit({ kind: "model", model: payload.model });
        }
    }

    private handleTurnFailed(event: { type: string; [key: string]: unknown }): void {
        if (this.deps.isCancelled()) {
            return;
        }
        this.deps.setReportedError();
        const error =
            typeof event.error === "object" && event.error !== null
                ? (event.error as Record<string, unknown>)
                : {};
        const failMessage =
            "message" in error && typeof error.message === "string"
                ? error.message
                : "codex turn failed";
        this.deps.emit({
            kind: "error",
            message: failMessage,
            retryable: isTransientErrorMessage(failMessage),
        });
        this.deps.emitTurnEnd();
    }

    private handleError(event: { type: string; [key: string]: unknown }): void {
        const message = typeof event.message === "string" ? event.message : "codex error";
        // "Reconnecting... N/5" are transient retry notices, not failures;
        // the terminal error (or turn.failed) is surfaced separately.
        if (/^Reconnecting\.\.\./.test(message)) {
            return;
        }
        if (this.deps.isCancelled()) {
            return;
        }
        this.deps.setReportedError();
        this.deps.emit({
            kind: "error",
            message,
            retryable: isTransientErrorMessage(message),
        });
    }

    /**
     * Normalize a Codex usage-bearing event and emit a `usage` UI event. Falls
     * back to the configured model's context window when Codex doesn't report
     * one (older exec streams omit model_context_window).
     */
    private emitUsage(event: unknown): void {
        const u = parseCodexUsage(event);
        if (!u) {
            return;
        }
        if (u.contextWindow) {
            this.lastContextWindow = u.contextWindow;
        }
        this.deps.emit({
            kind: "usage",
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheRead: u.cacheRead,
            contextWindow:
                u.contextWindow ?? this.lastContextWindow ?? this.deps.configuredContextWindow(),
            model: this.deps.model() || undefined,
        });
    }
}
