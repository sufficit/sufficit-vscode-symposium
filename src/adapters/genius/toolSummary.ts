type Arguments = Record<string, unknown>;

const sensitive =
    /(?:token|secret|password|credential|authorization|bearer|api[_-]?key|https?:\/\/)/i;

function visible(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (
        !text ||
        text.length > 100 ||
        [...text].some((char) => char.charCodeAt(0) < 32) ||
        sensitive.test(text)
    )
        return undefined;
    return text;
}

function fileName(value: unknown): string | undefined {
    const path = visible(value);
    return path?.split(/[\\/]/).at(-1) || undefined;
}

function parseArguments(input: string): Arguments {
    try {
        const parsed: unknown = JSON.parse(input);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Arguments)
            : {};
    } catch {
        return {};
    }
}

/** A display-only summary; the unmodified arguments remain in the expanded row. */
export function geniusToolSummary(name: string, input: string): string | undefined {
    const args = parseArguments(input);
    const intent = visible(args.intent);
    if (intent) return intent;

    if (name === "catalog") {
        const action = args.action || "search";
        if (action === "categories") return "Browse tool categories";
        if (action === "list") return "Browse tools";
        if (action === "activate") {
            const names = Array.isArray(args.names)
                ? args.names
                      .slice(0, 3)
                      .map(visible)
                      .filter((item) => item !== undefined)
                : [];
            return names.length ? `Activate ${names.join(", ")}` : "Activate tools";
        }
        const query = visible(args.query);
        return query ? `Search tools: ${query}` : "Search tools";
    }

    if (name === "shell_exec_parallel") {
        const count = Array.isArray(args.commands) ? args.commands.length : 0;
        return count > 0 ? `Run ${count} shell commands` : "Run shell commands";
    }
    if (name === "shell_exec" || name === "shell_job_start") {
        const command = visible(args.command);
        if (command && /^[\w./: -]+$/.test(command)) return command;
        const program = command
            ?.match(/^[\w./-]+/)?.[0]
            ?.split("/")
            .at(-1);
        return program ? `Run ${program}` : "Run shell command";
    }

    const target = fileName(args.file_path ?? args.path);
    if (target) return target;
    const query = visible(args.query);
    if (query) return `Search: ${query}`;
    return undefined;
}
