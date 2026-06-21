import { TodoItem } from "./types";
import { parseNativeTodos } from "./todos";

/**
 * Pure parsing/formatting helpers shared by the Claude adapter (and tests).
 * Deliberately free of vscode/fs imports so they can be unit-tested under
 * plain Node.
 */

/**
 * A short, human target for a tool call — the file, command, pattern or url —
 * so the UI can show "Read foo.ts" / "Ran npm test" instead of a raw JSON blob.
 */
export function summarizeToolInput(input: unknown): string {
    const o = (input ?? {}) as Record<string, unknown>;
    const short = (p: unknown) => {
        const parts = String(p).split("/").filter(Boolean);
        return parts.slice(-2).join("/") || String(p);
    };
    const filePath = typeof o.file_path === "string" ? o.file_path
        : typeof o.notebook_path === "string" ? o.notebook_path
            : typeof o.path === "string" ? o.path : undefined;
    let s = "";
    // A human-readable description (e.g. Bash tool's `description`) is the intent
    // the user cares about — prefer it over the raw command/args.
    if (typeof o.description === "string" && o.description.trim()) { s = o.description.trim(); }
    else if (filePath) {
        s = short(filePath);
        if (typeof o.offset === "number") {
            const end = typeof o.limit === "number" ? o.offset + o.limit : undefined;
            s += ":" + o.offset + (end ? "-" + end : "");
        }
    }
    else if (typeof o.command === "string") { s = o.command.trim().replace(/\s+/g, " "); }
    else if (typeof o.pattern === "string") { s = '"' + o.pattern + '"' + (typeof o.path === "string" ? " in " + short(o.path) : ""); }
    else if (typeof o.url === "string") { s = o.url; }
    else if (typeof o.query === "string") { s = o.query; }
    else if (typeof o.description === "string") { s = o.description; }
    else if (typeof o.prompt === "string") { s = o.prompt; }
    else {
        const first = Object.values(o).find((v) => typeof v === "string") as string | undefined;
        s = first ?? "";
    }
    return s.length > 160 ? s.slice(0, 157) + "..." : s;
}

/** Context window (tokens) for a Claude model; default 200k. */
export function contextWindowFor(model: string): number {
    const m = (model || "").toLowerCase();
    if (m.includes("[1m]") || m.includes("-1m")) { return 1000000; }
    return 200000;
}

/** Token usage extracted from a Codex event, normalized to the UI's shape. */
export interface CodexUsage {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    contextWindow?: number;
}

/**
 * Extract token usage from a Codex `exec --json` event. Codex reports usage in
 * two shapes depending on version/transport:
 *   1. turn.completed → { usage: { input_tokens, cached_input_tokens, output_tokens } }
 *   2. event_msg/token_count → { info: { last_token_usage: {...}, model_context_window } }
 * Returns undefined when the event carries no usage numbers, so the caller can
 * skip emitting an empty usage event.
 *
 * NOTE: input_tokens from Codex ALREADY INCLUDES cached_input_tokens, so we must
 * NOT add them again (unlike Claude, where cache reads are a separate bucket).
 */
export function parseCodexUsage(event: unknown): CodexUsage | undefined {
    const e = (event ?? {}) as Record<string, any>;
    // Shape 2: token_count carries the richest data (incl. context window).
    const info = e.info ?? e.payload?.info;
    const u = info?.last_token_usage ?? info?.total_token_usage ?? e.usage ?? e.message?.usage;
    if (!u || typeof u !== "object") { return undefined; }
    const input = Number(u.input_tokens ?? 0);
    const output = Number(u.output_tokens ?? 0);
    const cached = Number(u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0);
    if (!input && !output && !cached) { return undefined; }
    const win = Number(info?.model_context_window ?? 0) || undefined;
    return { inputTokens: input, outputTokens: output, cacheRead: cached, contextWindow: win };
}

/** Absolute file a tool acts on (Read/Edit/Write/NotebookEdit), if any. */
export function toolFilePath(input: unknown): string | undefined {
    const o = (input ?? {}) as Record<string, unknown>;
    const p = o.file_path ?? o.notebook_path;
    return typeof p === "string" && p ? p : undefined;
}

/** Line count of a string block (0 for empty/missing). */
export function lineCount(s: unknown): number {
    return typeof s === "string" && s.length ? s.split("\n").length : 0;
}

/**
 * Approximate added/removed line counts for a write/edit tool. Edit: new vs old
 * string; MultiEdit: summed; Write: whole content added.
 */
export function diffCounts(name: string, input: unknown): { added: number; removed: number } | undefined {
    const o = (input ?? {}) as Record<string, unknown>;
    if (name === "Write" || name === "write_file") {
        return { added: lineCount(o.content), removed: 0 };
    }
    if (name === "Edit" || name === "edit_file") {
        return { added: lineCount(o.new_string), removed: lineCount(o.old_string) };
    }
    if (name === "MultiEdit" && Array.isArray(o.edits)) {
        let added = 0, removed = 0;
        for (const e of o.edits as any[]) { added += lineCount(e?.new_string); removed += lineCount(e?.old_string); }
        return { added, removed };
    }
    return undefined;
}

/** Old/new hunks for an edit tool, for a red/green diff view. */
export function editDiff(name: string, input: unknown): { old: string; new: string }[] | undefined {
    const o = (input ?? {}) as Record<string, unknown>;
    if ((name === "Edit" || name === "edit_file") && typeof o.old_string === "string") {
        return [{ old: o.old_string, new: typeof o.new_string === "string" ? o.new_string : "" }];
    }
    if (name === "MultiEdit" && Array.isArray(o.edits)) {
        return (o.edits as any[])
            .map((e) => ({ old: String(e?.old_string ?? ""), new: String(e?.new_string ?? "") }))
            .filter((e) => e.old || e.new);
    }
    if (name === "Write" && typeof o.content === "string") {
        return [{ old: "", new: o.content }];
    }
    return undefined;
}

/** Extract a plan/todo list from a tool call, if it is one. */
export function extractTodos(name: string, input: unknown): TodoItem[] | undefined {
    return parseNativeTodos(name, input);
}

/** Pretty-print a tool input for the expandable panel (capped). */
export function prettyJson(input: unknown): string {
    try {
        const s = JSON.stringify(input, null, 2);
        return s.length > 6000 ? s.slice(0, 6000) + "\n…(truncated)" : s;
    } catch {
        return String(input ?? "");
    }
}

/** Flatten a tool_result content (string or content blocks) to text (capped). */
export function toolResultText(content: unknown): string {
    let s: string;
    if (typeof content === "string") {
        s = content;
    } else if (Array.isArray(content)) {
        s = content.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("");
    } else {
        try { s = JSON.stringify(content); } catch { s = String(content ?? ""); }
    }
    return s.length > 6000 ? s.slice(0, 6000) + "\n…(truncated)" : s;
}

/**
 * Best-effort MIME type from a file path extension. Returns undefined when the
 * extension is unknown so callers can omit the hint rather than guess wrong.
 */
export function mimeTypeFor(path: string): string | undefined {
    const m = /\.([a-z0-9]+)$/i.exec(path.trim());
    if (!m) { return undefined; }
    const ext = m[1].toLowerCase();
    const map: Record<string, string> = {
        // text / code
        txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
        json: "application/json", jsonc: "application/json",
        yaml: "application/yaml", yml: "application/yaml", toml: "application/toml",
        xml: "application/xml", html: "text/html", htm: "text/html",
        css: "text/css", csv: "text/csv", tsv: "text/tab-separated-values",
        js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
        ts: "text/typescript", tsx: "text/typescript", jsx: "text/javascript",
        py: "text/x-python", rb: "text/x-ruby", go: "text/x-go", rs: "text/x-rust",
        java: "text/x-java", c: "text/x-c", h: "text/x-c", cpp: "text/x-c++", cc: "text/x-c++",
        cs: "text/x-csharp", php: "text/x-php", sh: "application/x-sh", bash: "application/x-sh",
        sql: "application/sql", ini: "text/plain", cfg: "text/plain", conf: "text/plain",
        log: "text/plain", env: "text/plain", svg: "image/svg+xml",
        // images
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
        tif: "image/tiff", tiff: "image/tiff", avif: "image/avif", heic: "image/heic",
        // docs / archives / media
        pdf: "application/pdf", zip: "application/zip", gz: "application/gzip",
        tar: "application/x-tar", "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
        mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
        wasm: "application/wasm",
    };
    return map[ext];
}
