import * as path from "node:path";
import { JsonlMetadataCache, readJsonlPrefix, readJsonlTail } from "../jsonlPrefix";
import { HistoryMessage } from "../types";

export interface GeminiSessionMeta {
    title?: string;
    cwd?: string;
    model?: string;
}

interface GeminiTranscriptRow {
    type?: unknown;
    source?: unknown;
    content?: unknown;
    model?: unknown;
    model_name?: unknown;
    timestamp?: unknown;
    created_at?: unknown;
    createdAt?: unknown;
    metadata?: { model?: unknown };
}

const metadataCache = new JsonlMetadataCache<GeminiSessionMeta>();
const METADATA_PREFIX_BYTES = 512 * 1024;
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;

/** Extracts the clean user request from prompt content containing XML tags. */
export function extractUserPromptText(content: string): string {
    if (!content) {
        return "";
    }
    const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(content);
    return (match ? match[1] : content).trim();
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
    const activeDocument = /Active Document:\s*([^\r\n]+)/.exec(content)?.[1]?.trim();
    if (!activeDocument) {
        return undefined;
    }
    const withoutLanguage = activeDocument.replace(/\s+\([^)]*\)\s*$/, "");
    const separator = Math.max(withoutLanguage.lastIndexOf("/"), withoutLanguage.lastIndexOf("\\"));
    return separator > 0 ? withoutLanguage.slice(0, separator) : path.dirname(withoutLanguage);
}

/** Parses one Gemini/Antigravity transcript row into a visible message. */
export function parseGeminiTranscriptLine(line: string): HistoryMessage[] {
    const row = parseRow(line);
    if (!row) {
        return [];
    }
    const type = stringValue(row.type).toUpperCase();
    const source = stringValue(row.source).toUpperCase();
    const role =
        type === "USER_INPUT" || source === "USER_EXPLICIT"
            ? "user"
            : type === "PLANNER_RESPONSE" || type === "MODEL_RESPONSE" || source === "MODEL"
              ? "assistant"
              : undefined;
    if (!role) {
        return [];
    }
    const rawText = contentText(row.content);
    const text = role === "user" ? extractUserPromptText(rawText) : rawText.trim();
    if (!text) {
        return [];
    }
    const timestamp = row.timestamp ?? row.created_at ?? row.createdAt;
    const parsedTime =
        typeof timestamp === "number" ? timestamp : Date.parse(stringValue(timestamp));
    const model = role === "assistant" ? modelValue(row) : undefined;
    return [
        {
            role,
            text,
            ...(model ? { model, modelLabel: model } : {}),
            ...(Number.isFinite(parsedTime) ? { ts: parsedTime } : {}),
        },
    ];
}

/** Reads basic session metadata using bounded prefix I/O. */
export function readGeminiMeta(filePath: string): Promise<GeminiSessionMeta> {
    return metadataCache.get(filePath, async () =>
        parseGeminiMeta(await readJsonlPrefix(filePath, METADATA_PREFIX_BYTES)),
    );
}

/** Reconstructs the recent visible conversation without loading huge logs in full. */
export async function readGeminiHistory(filePath: string): Promise<HistoryMessage[]> {
    const content = await readJsonlTail(filePath, HISTORY_TAIL_BYTES);
    return content.split("\n").flatMap(parseGeminiTranscriptLine);
}

function parseGeminiMeta(content: string): GeminiSessionMeta {
    const meta: GeminiSessionMeta = {};
    for (const line of content.split("\n")) {
        const row = parseRow(line);
        if (!row) {
            continue;
        }
        meta.model ??= modelValue(row);
        const type = stringValue(row.type).toUpperCase();
        const source = stringValue(row.source).toUpperCase();
        if (type !== "USER_INPUT" && source !== "USER_EXPLICIT") {
            continue;
        }
        const text = contentText(row.content);
        meta.cwd ??= extractWorkspaceCwd(text);
        if (!meta.title) {
            const prompt = extractUserPromptText(text);
            const firstLine = prompt.split("\n").find((candidate) => candidate.trim());
            meta.title = (firstLine || prompt).slice(0, 100).trim() || undefined;
        }
        if (meta.title && meta.cwd && meta.model) {
            break;
        }
    }
    return meta;
}

function parseRow(line: string): GeminiTranscriptRow | undefined {
    if (!line.trim()) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" ? (parsed as GeminiTranscriptRow) : undefined;
    } catch {
        return undefined;
    }
}

function modelValue(row: GeminiTranscriptRow): string | undefined {
    for (const value of [row.model, row.model_name, row.metadata?.model]) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function contentText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((block) => {
            if (typeof block === "string") {
                return block;
            }
            if (block && typeof block === "object" && "text" in block) {
                return stringValue((block as { text?: unknown }).text);
            }
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}
