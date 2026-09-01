import {
    diffCounts,
    editDiff,
    extractTodos,
    prettyJson,
    summarizeToolInput,
    toolFilePath,
} from "../parse";
import { JsonlMetadataCache, readJsonlPrefix } from "../jsonlPrefix";
import { blockedQuotaRetryAt } from "../quota";
import { HistoryMessage } from "../types";
import { ClaudeTaskTracker } from "./tasks";
import { parseClaudeQuota } from "./usage";

/**
 * Cleans a stored user message for display: slash-command invocations are
 * saved with a `<command-name>/<command-args>`/`<command-message>` envelope
 * (plus a `<local-command-*>`/caveat) — collapse those to `/name args`, and
 * drop other injected `<...>` system wrappers, so the transcript reads like
 * the chat the user actually typed.
 */
function cleanUserText(raw: string): string {
    const text = String(raw);
    const name = /<command-name>([^<]*)<\/command-name>/.exec(text);
    if (name) {
        const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
        const cmd = name[1].trim().replace(/^\//, "");
        return ("/" + cmd + (args && args[1].trim() ? " " + args[1].trim() : "")).trim();
    }
    // System reminders / caveats wrapped in tags are not user input.
    if (/^<(local-command|command-message|system-reminder|command-stdout)/.test(text.trim())) {
        return "";
    }
    return text.trim();
}

/** Defensive read of a transcript line's raw top-level `type` (for status inference). */
export function rawLineType(line: string): string | undefined {
    if (!line.trim()) {
        return undefined;
    }
    try {
        const entry = JSON.parse(line) as { type?: unknown };
        return typeof entry.type === "string" ? entry.type : undefined;
    } catch {
        return undefined;
    }
}

/** Turn activity encoded by current and legacy Claude Code JSONL formats. */
export function rawLineActivity(line: string): "working" | "idle" | undefined {
    if (!line.trim()) return undefined;
    try {
        const entry = JSON.parse(line) as {
            type?: unknown;
            isMeta?: unknown;
            message?: { stop_reason?: unknown };
        };
        if (entry.isMeta === true) return undefined;
        if (entry.type === "result") return "idle";
        if (entry.type === "user") return "working";
        if (entry.type !== "assistant") return undefined;
        return entry.message?.stop_reason === "end_turn" ? "idle" : "working";
    } catch {
        return undefined;
    }
}

/** Parses one transcript JSONL line into chat messages (text + tool calls). */
export function parseTranscriptLine(
    line: string,
    taskTracker?: ClaudeTaskTracker,
): HistoryMessage[] {
    if (!line.trim()) {
        return [];
    }
    interface TranscriptEntry {
        isMeta?: boolean;
        type: "user" | "assistant" | "result";
        model?: string;
        effort?: string;
        reasoning?: string;
        message?: {
            model?: string;
            effort?: string;
            reasoning?: string;
            reasoning_effort?: string;
            content?:
                | string
                | Array<{
                      type: string;
                      text?: string;
                      thinking?: string;
                      id?: string;
                      name?: string;
                      input?: unknown;
                      tool_use_id?: string;
                  }>;
        };
        is_error?: boolean;
        result?: unknown;
        subtype?: unknown;
        toolUseResult?: unknown;
        timestamp?: string;
    }
    let entry: TranscriptEntry;
    try {
        entry = JSON.parse(line);
    } catch {
        return [];
    }
    if (entry.isMeta) {
        return [];
    }
    const messages: HistoryMessage[] = [];
    const entryModel =
        typeof entry.model === "string"
            ? entry.model
            : typeof entry.message?.model === "string"
              ? entry.message.model
              : undefined;
    const entryEffort =
        entry.effort ??
        entry.reasoning ??
        entry.message?.effort ??
        entry.message?.reasoning ??
        entry.message?.reasoning_effort;
    const entryReasoning = typeof entryEffort === "string" ? entryEffort : undefined;
    if (entry.type === "user") {
        const content = entry.message?.content;
        if (typeof content === "string") {
            const t = cleanUserText(content);
            if (t) {
                messages.push({ role: "user", text: t });
            }
        } else if (Array.isArray(content)) {
            for (const block of content) {
                if (
                    typeof block === "object" &&
                    block !== null &&
                    block.type === "text" &&
                    typeof block.text === "string"
                ) {
                    const t = cleanUserText(block.text);
                    if (t) {
                        messages.push({ role: "user", text: t });
                    }
                }
                if (typeof block === "object" && block !== null && block.type === "tool_result") {
                    const toolId =
                        typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
                            ? (block as { tool_use_id: string }).tool_use_id
                            : undefined;
                    const todos = taskTracker?.observeToolResult(toolId, entry.toolUseResult);
                    // Task results are normally hidden because their tool row was
                    // already rendered. A changed native task snapshot is the
                    // exception: emit a hidden todo render update for the panel.
                    if (todos) {
                        messages.push({
                            role: "tool",
                            text: "TodoWrite",
                            toolName: "TodoWrite",
                            todos,
                        });
                    }
                }
            }
        }
    } else if (entry.type === "assistant") {
        const assistantContent = entry.message?.content;
        for (const block of Array.isArray(assistantContent) ? assistantContent : []) {
            if (typeof block === "object" && block !== null) {
                if (block.type === "thinking" && typeof block.thinking === "string") {
                    if (block.thinking.trim()) {
                        messages.push({ role: "thinking", text: block.thinking });
                    }
                } else if (block.type === "text" && typeof block.text === "string") {
                    messages.push({
                        role: "assistant",
                        text: block.text,
                        ...(entryModel ? { model: entryModel } : {}),
                        ...(entryReasoning ? { reasoning: entryReasoning } : {}),
                    });
                } else if (block.type === "tool_use") {
                    const counts = diffCounts(block.name ?? "", block.input);
                    messages.push({
                        role: "tool",
                        text: block.name ?? "",
                        toolName: block.name ?? "",
                        detail: summarizeToolInput(block.input),
                        input: prettyJson(block.input),
                        added: counts?.added,
                        removed: counts?.removed,
                        todos:
                            extractTodos(block.name ?? "", block.input) ??
                            taskTracker?.observeToolUse(block.name ?? "", block.input, block.id),
                        path: toolFilePath(block.input),
                        diff: editDiff(block.name ?? "", block.input),
                    });
                }
            }
        }
    } else if (entry.type === "result" && entry.is_error) {
        // A failed turn (e.g. usage/session limit) is stored as a `result`
        // entry with is_error. Re-render it as an error row so reloaded
        // history keeps the same red styling it had when it happened live.
        const msg =
            typeof entry.result === "string" && entry.result.trim()
                ? entry.result.trim()
                : typeof entry.subtype === "string"
                  ? entry.subtype
                  : "unknown error";
        const retryAt = blockedQuotaRetryAt(parseClaudeQuota(entry, "claude"));
        messages.push({
            role: "error",
            text: msg,
            ...(retryAt !== undefined ? { retryable: true, retryAt } : {}),
        });
    }
    // Stamp the transcript time so history shows real timestamps on hover.
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
        for (const m of messages) {
            m.ts = ts;
        }
    }
    return messages;
}

/**
 * Reads the first user prompt (title) and the session's original working
 * directory from a transcript. The cwd matters: `claude --resume` only finds
 * sessions that belong to the directory it is started in.
 */
export interface ClaudeSessionMeta {
    title?: string;
    cwd?: string;
    gitBranch?: string;
    originSessionId?: string;
    model?: string;
    reasoning?: string;
}

const claudeMetaCache = new JsonlMetadataCache<ClaudeSessionMeta>();
const CLAUDE_META_PREFIX_BYTES = 512 * 1024;

export async function readSessionMeta(file: string): Promise<ClaudeSessionMeta> {
    return claudeMetaCache.get(file, async () =>
        parseSessionMeta(await readJsonlPrefix(file, CLAUDE_META_PREFIX_BYTES)),
    );
}

function parseSessionMeta(content: string): ClaudeSessionMeta {
    let title: string | undefined;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let model: string | undefined;
    let reasoning: string | undefined;
    for (const line of content.split("\n").slice(0, 30)) {
        try {
            const entry = JSON.parse(line);
            if (!cwd && typeof entry.cwd === "string" && entry.cwd) {
                cwd = entry.cwd;
            }
            if (!gitBranch && typeof entry.gitBranch === "string" && entry.gitBranch) {
                gitBranch = entry.gitBranch;
            }
            const message = entry.message;
            if (!model && typeof message?.model === "string" && message.model) {
                model = message.model;
            }
            const effort =
                entry.effort ?? entry.reasoning ?? message?.effort ?? message?.reasoning_effort;
            if (!reasoning && typeof effort === "string" && effort) {
                reasoning = effort;
            }
            if (!title && entry.type === "user") {
                const c = entry.message?.content;
                if (typeof c === "string" && c.trim() && !c.startsWith("<")) {
                    title = c.slice(0, 80);
                } else if (Array.isArray(c)) {
                    const text = c.find(
                        (b: { type: string; text?: string }) => b.type === "text",
                    )?.text;
                    if (text) {
                        title = String(text).slice(0, 80);
                    }
                }
            }
            if (title && cwd && gitBranch && model && reasoning) {
                break;
            }
        } catch {
            // non-JSON lines are skipped
        }
    }
    // Conversation lineage: claude-mem embeds memories tagged with the session
    // that originally created them (originSessionId). The dominant one identifies
    // the original conversation that this session continues / builds on — so
    // sessions sharing it are the same logical conversation.
    let originSessionId: string | undefined;
    const om = content.match(/originSessionId:\s*([0-9a-f-]{36})/g);
    if (om && om.length) {
        const counts: Record<string, number> = {};
        for (const x of om) {
            const id = x.replace(/originSessionId:\s*/, "");
            counts[id] = (counts[id] || 0) + 1;
        }
        originSessionId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }
    return {
        title,
        cwd,
        gitBranch,
        originSessionId,
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
    };
}
