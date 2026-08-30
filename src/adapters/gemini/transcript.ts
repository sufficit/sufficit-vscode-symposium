import * as fs from "fs";
import * as readline from "readline";

export interface GeminiSessionMeta {
    id?: string;
    title?: string;
    cwd?: string;
    model?: string;
}

/** Extracts the clean user request from prompt content containing XML tags. */
export function extractUserPromptText(content: string): string {
    if (!content) {
        return "";
    }
    const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(content);
    const raw = match ? match[1] : content;
    return raw.trim();
}

/** Extracts the workspace/cwd from additional metadata blocks if present. */
export function extractWorkspaceCwd(content: string): string | undefined {
    if (!content) {
        return undefined;
    }
    const workspaceMatch = /\[URI\]\s*->\s*([^\r\n]+)/.exec(content);
    if (workspaceMatch) {
        return workspaceMatch[1].trim();
    }
    const activeDocMatch = /Active Document:\s*([^\r\n]+)/.exec(content);
    if (activeDocMatch) {
        const docPath = activeDocMatch[1].trim();
        const lastSlash = docPath.lastIndexOf("/");
        return lastSlash > 0 ? docPath.slice(0, lastSlash) : docPath;
    }
    return undefined;
}

/** Reads basic session metadata from a Gemini/Antigravity transcript.jsonl file. */
export async function readGeminiMeta(filePath: string): Promise<GeminiSessionMeta> {
    const meta: GeminiSessionMeta = {};
    if (!fs.existsSync(filePath)) {
        return meta;
    }
    let fileStream: fs.ReadStream;
    try {
        fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch {
        return meta;
    }

    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    let linesRead = 0;
    for await (const line of rl) {
        linesRead++;
        if (linesRead > 50 && meta.title && meta.cwd) {
            break;
        }
        if (!line.trim()) {
            continue;
        }
        try {
            const row = JSON.parse(line) as {
                type?: string;
                source?: string;
                content?: string;
                model?: string;
            };
            if (!meta.model && typeof row.model === "string" && row.model) {
                meta.model = row.model;
            }
            if (row.type === "USER_INPUT" || row.source === "USER_EXPLICIT") {
                const text = typeof row.content === "string" ? row.content : "";
                if (!meta.cwd) {
                    meta.cwd = extractWorkspaceCwd(text);
                }
                if (!meta.title) {
                    const prompt = extractUserPromptText(text);
                    if (prompt) {
                        const firstLine = prompt.split("\n").find((l) => l.trim());
                        meta.title = (firstLine || prompt).slice(0, 100).trim();
                    }
                }
            }
        } catch {
            /* ignore unparseable line */
        }
    }
    return meta;
}
