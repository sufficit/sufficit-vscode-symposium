import * as fs from "fs";
import {
    diffCounts, editDiff, extractTodos,
    prettyJson, summarizeToolInput, toolFilePath,
} from "../parse";
import { HistoryMessage } from "../types";

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
    if (!line.trim()) { return undefined; }
    try {
        const entry = JSON.parse(line) as { type?: unknown };
        return typeof entry.type === "string" ? entry.type : undefined;
    } catch {
        return undefined;
    }
}

/** Parses one transcript JSONL line into chat messages (text + tool calls). */
export function parseTranscriptLine(line: string): HistoryMessage[] {
    if (!line.trim()) {
        return [];
    }
    let entry: any;
    try {
        entry = JSON.parse(line);
    } catch {
        return [];
    }
    if (entry.isMeta) {
        return [];
    }
    const messages: HistoryMessage[] = [];
    if (entry.type === "user") {
        const content = entry.message?.content;
        if (typeof content === "string") {
            const t = cleanUserText(content);
            if (t) { messages.push({ role: "user", text: t }); }
        } else if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === "text" && block.text?.trim()) {
                    const t = cleanUserText(block.text);
                    if (t) { messages.push({ role: "user", text: t }); }
                }
                // tool_result blocks are skipped: the tool line was already added
            }
        }
    } else if (entry.type === "assistant") {
        for (const block of entry.message?.content ?? []) {
            if (block.type === "thinking" && block.thinking?.trim()) {
                messages.push({ role: "thinking", text: block.thinking });
            } else if (block.type === "text" && block.text?.trim()) {
                messages.push({ role: "assistant", text: block.text });
            } else if (block.type === "tool_use") {
                const counts = diffCounts(block.name, block.input);
                messages.push({
                    role: "tool", text: block.name, toolName: block.name,
                    detail: summarizeToolInput(block.input), input: prettyJson(block.input),
                    added: counts?.added, removed: counts?.removed,
                    todos: extractTodos(block.name, block.input),
                    path: toolFilePath(block.input),
                    diff: editDiff(block.name, block.input),
                });
            }
        }
    } else if (entry.type === "result" && entry.is_error) {
        // A failed turn (e.g. usage/session limit) is stored as a `result`
        // entry with is_error. Re-render it as an error row so reloaded
        // history keeps the same red styling it had when it happened live.
        const msg = (typeof entry.result === "string" && entry.result.trim())
            ? entry.result.trim()
            : (entry.subtype ?? "unknown error");
        messages.push({ role: "error", text: msg });
    }
    // Stamp the transcript time so history shows real timestamps on hover.
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(ts)) { for (const m of messages) { m.ts = ts; } }
    return messages;
}

/**
 * Reads the first user prompt (title) and the session's original working
 * directory from a transcript. The cwd matters: `claude --resume` only finds
 * sessions that belong to the directory it is started in.
 */
export async function readSessionMeta(file: string): Promise<{ title?: string; cwd?: string }> {
    let content: string;
    try {
        content = await fs.promises.readFile(file, "utf8");
    } catch {
        return {};
    }
    let title: string | undefined;
    let cwd: string | undefined;
    for (const line of content.split("\n").slice(0, 30)) {
        try {
            const entry = JSON.parse(line);
            if (!cwd && typeof entry.cwd === "string" && entry.cwd) {
                cwd = entry.cwd;
            }
            if (!title && entry.type === "user") {
                const c = entry.message?.content;
                if (typeof c === "string" && c.trim() && !c.startsWith("<")) {
                    title = c.slice(0, 80);
                } else if (Array.isArray(c)) {
                    const text = c.find((b: any) => b.type === "text")?.text;
                    if (text) {
                        title = String(text).slice(0, 80);
                    }
                }
            }
            if (title && cwd) {
                break;
            }
        } catch {
            // non-JSON lines are skipped
        }
    }
    return { title, cwd };
}
