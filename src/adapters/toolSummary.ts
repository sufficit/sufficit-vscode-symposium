/**
 * Shared tool-call summarization for all agent adapters.
 * Pure functions (no vscode/fs imports) so they can be unit-tested under Node.
 *
 * Produces a short, human `detail` for a tool call — the file, command,
 * pattern or url — so the UI shows "Read foo.ts" / "Ran npm test" instead of
 * a raw JSON blob. Credentials and URLs are never surfaced: any candidate
 * string that looks sensitive (token/secret/password/authorization/bearer/
 * api key/http(s) URL) or contains control characters is rejected, so the
 * caller falls back to a generic label and the raw arguments stay only in
 * the expandable row.
 */

type Arguments = Record<string, unknown>;

const sensitive =
    /(?:token|secret|password|credential|authorization|bearer|api[_-]?key|https?:\/\/)/i;

/** Max length of an emitted summary (matches the historical Claude cap). */
const MAX_SUMMARY_LENGTH = 160;

function isSafe(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const text = value.trim();
    return (
        !!text &&
        text.length <= MAX_SUMMARY_LENGTH &&
        ![...text].some((char) => char.charCodeAt(0) < 32) &&
        !sensitive.test(text)
    );
}

function safeText(value: unknown): string | undefined {
    return isSafe(value) ? (value as string).trim() : undefined;
}

function fileName(value: unknown): string | undefined {
    const path = safeText(value);
    return path?.split(/[\\/]/).at(-1) || undefined;
}

function parseArguments(input: unknown): Arguments {
    let raw: unknown = input;
    if (typeof input === "string") {
        try {
            raw = JSON.parse(input);
        } catch {
            return {};
        }
    }
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Arguments) : {};
}

function truncate(text: string): string {
    return text.length > MAX_SUMMARY_LENGTH ? text.slice(0, MAX_SUMMARY_LENGTH - 3) + "..." : text;
}

/** Command text: whitespace-collapsed, credential-filtered, hard-capped. */
function commandText(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.trim().replace(/\s+/g, " ");
    if (!text || [...text].some((char) => char.charCodeAt(0) < 32) || sensitive.test(text))
        return undefined;
    return truncate(text);
}

function pathSegments(path: string, count: number): string | undefined {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.slice(-count).join("/") || undefined;
}

/**
 * File target. `segments` controls how much of the path is shown: Claude's
 * historical summary used the last two segments ("src/app.ts"), while the
 * Genius rows show just the basename.
 */
function fileTarget(o: Arguments, segments: number): string | undefined {
    const path =
        typeof o.file_path === "string"
            ? o.file_path
            : typeof o.notebook_path === "string"
              ? o.notebook_path
              : typeof o.path === "string"
                ? o.path
                : undefined;
    if (!path || !isSafe(path)) return undefined;
    let target = pathSegments(path, segments)!;
    if (typeof o.offset === "number") {
        const end = typeof o.limit === "number" ? o.offset + o.limit : undefined;
        target += ":" + o.offset + (end ? "-" + end : "");
    }
    return target;
}

/** Genius-specific heuristics by tool name; undefined when not applicable. */
function geniusNamedSummary(name: string, args: Arguments): string | undefined {
    if (name === "catalog") {
        const action = args.action || "search";
        if (action === "categories") return "Browse tool categories";
        if (action === "list") return "Browse tools";
        if (action === "activate") {
            const names = Array.isArray(args.names)
                ? args.names
                      .slice(0, 3)
                      .map(safeText)
                      .filter((item) => item !== undefined)
                : [];
            return names.length ? `Activate ${names.join(", ")}` : "Activate tools";
        }
        const query = safeText(args.query);
        return query ? `Search tools: ${query}` : "Search tools";
    }
    if (name === "shell_exec_parallel") {
        const count = Array.isArray(args.commands) ? args.commands.length : 0;
        return count > 0 ? `Run ${count} shell commands` : "Run shell commands";
    }
    if (name === "shell_exec" || name === "shell_job_start") {
        const command = commandText(args.command);
        if (command && /^[\w./: -]+$/.test(command)) return command;
        const program = command
            ?.match(/^[\w./-]+/)?.[0]
            ?.split("/")
            .at(-1);
        return program && /^[\w.-]+$/.test(program) ? `Run ${program}` : "Run shell command";
    }
    return undefined;
}

/**
 * Shared summary for a tool call.
 * @param name tool name (may be empty for unknown/generic callers)
 * @param input tool arguments (object or JSON string; unknown shapes are tolerated)
 * @param fileSegments how many trailing path segments to show for file targets
 *   (1 = basename; 2 = "dir/file.ts"). Defaults to 1.
 * @returns a short display string, or undefined when nothing safe could be derived
 */
export function toolSummary(name: string, input: unknown, fileSegments = 1): string | undefined {
    const args = parseArguments(input);

    // An explicit human intent declared by the tool wins over any heuristic.
    const intent = safeText(args.intent) ?? safeText(args.description);
    if (intent) return intent;

    const named = name ? geniusNamedSummary(name, args) : undefined;
    if (named) return named;

    const file = fileTarget(args, fileSegments);
    if (file) return file;

    const command = commandText(args.command);
    if (command) return command;

    if (typeof args.pattern === "string") {
        const pattern = safeText(args.pattern);
        if (pattern) {
            const base = `"${pattern}"`;
            const dir = fileName(args.path);
            return dir ? `${base} in ${dir}` : base;
        }
    }

    const url = safeText(args.url);
    if (url) return url;

    const query = safeText(args.query);
    if (query) return truncate(query);

    const prompt = safeText(args.prompt);
    if (prompt) return truncate(prompt);

    // Last resort: first safe string value in the arguments.
    for (const value of Object.values(args)) {
        const text = safeText(value);
        if (text) return truncate(text);
    }
    return undefined;
}

/**
 * Backwards-compatible generic summarizer (historically Claude's
 * `summarizeToolInput`). Never returns credentials/URLs; returns "" when
 * nothing safe could be derived. Shows the last two path segments, matching
 * Claude's historical format ("src/app.ts").
 */
export function summarizeToolInput(input: unknown): string {
    return toolSummary("", input, 2) ?? "";
}
