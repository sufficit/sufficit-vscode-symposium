import * as fs from "fs";

/**
 * Codex sessions begin with injected scaffolding (AGENTS.md, IDE context,
 * environment tags) before the real prompt. These are wrapped in tags or
 * markdown headers, so skip `<...>` blocks and `# `-headed context for
 * titles and history.
 */
export function looksInjected(text: string): boolean {
    return text.startsWith("<") || text.startsWith("# ");
}

/** Reads the session_meta line (id, cwd) and first real user prompt (title). */
export async function readCodexMeta(file: string): Promise<{ id?: string; cwd?: string; title?: string }> {
    let content: string;
    try {
        content = await fs.promises.readFile(file, "utf8");
    } catch {
        return {};
    }
    let id: string | undefined;
    let cwd: string | undefined;
    let title: string | undefined;
    for (const line of content.split("\n").slice(0, 60)) {
        if (!line.trim()) {
            continue;
        }
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry.type === "session_meta") {
            id = entry.payload?.id;
            cwd = entry.payload?.cwd;
        } else if (!title && entry.type === "response_item" && entry.payload?.type === "message" && entry.payload.role === "user") {
            const text = (entry.payload.content ?? [])
                .filter((c: any) => c.type === "input_text" || c.type === "text")
                .map((c: any) => c.text)
                .join("")
                .trim();
            if (text && !looksInjected(text)) {
                title = text.slice(0, 80);
            }
        }
        if (id && title) {
            break;
        }
    }
    return { id, cwd, title };
}
