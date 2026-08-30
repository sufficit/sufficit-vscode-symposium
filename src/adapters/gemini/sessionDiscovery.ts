import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionInfo } from "../types";
import { readGeminiMeta } from "./transcript";

export type GeminiSessionSource = "gemini" | "antigravity";

export interface GeminiDiscoveryOptions {
    roots?: Record<GeminiSessionSource, string>;
    sources?: readonly GeminiSessionSource[];
    limit?: number;
}

export function defaultGeminiRoots(): Record<GeminiSessionSource, string> {
    const geminiRoot = path.join(os.homedir(), ".gemini");
    return {
        gemini: path.join(geminiRoot, "history"),
        antigravity: path.join(geminiRoot, "antigravity-ide", "brain"),
    };
}

/** Discovers Gemini and Antigravity transcripts and reuses unchanged metadata. */
export async function listGeminiSessions(
    cached: readonly SessionInfo[],
    options: GeminiDiscoveryOptions = {},
): Promise<SessionInfo[]> {
    const cachedByPath = new Map(
        cached.filter((item) => item.transcriptPath).map((item) => [item.transcriptPath!, item]),
    );
    const roots = options.roots ?? defaultGeminiRoots();
    const sources = options.sources ?? (["gemini", "antigravity"] as const);
    const discovered = await Promise.all(
        sources.map((source) => scanSource(source, roots[source], cachedByPath)),
    );
    return discovered
        .flat()
        .sort((left, right) => updatedAt(right) - updatedAt(left))
        .slice(0, options.limit ?? 50);
}

async function scanSource(
    source: GeminiSessionSource,
    root: string,
    cachedByPath: ReadonlyMap<string, SessionInfo>,
): Promise<SessionInfo[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const candidates = entries.flatMap((entry) => {
        if (source === "antigravity" && entry.isDirectory()) {
            return [
                {
                    sessionId: entry.name,
                    transcriptPath: path.join(
                        root,
                        entry.name,
                        ".system_generated",
                        "logs",
                        "transcript.jsonl",
                    ),
                },
            ];
        }
        if (source === "gemini" && entry.isFile() && entry.name.endsWith(".jsonl")) {
            return [
                {
                    sessionId: path.basename(entry.name, ".jsonl"),
                    transcriptPath: path.join(root, entry.name),
                },
            ];
        }
        return [];
    });
    const sessions = await Promise.all(
        candidates.map(({ sessionId, transcriptPath }) =>
            readCandidate(source, sessionId, transcriptPath, cachedByPath),
        ),
    );
    return sessions.filter((session): session is SessionInfo => session !== undefined);
}

async function readCandidate(
    source: GeminiSessionSource,
    sessionId: string,
    transcriptPath: string,
    cachedByPath: ReadonlyMap<string, SessionInfo>,
): Promise<SessionInfo | undefined> {
    try {
        const stat = await fs.promises.stat(transcriptPath);
        if (!stat.isFile()) {
            return undefined;
        }
        const cached = cachedByPath.get(transcriptPath);
        if (cached?.updatedAt?.getTime() === stat.mtimeMs) {
            return cached;
        }
        const meta = await readGeminiMeta(transcriptPath);
        const fallback = source === "antigravity" ? "Antigravity" : "Gemini";
        return {
            backend: source,
            sessionId,
            title: meta.title ?? fallback + " " + sessionId.slice(0, 8),
            cwd: meta.cwd,
            model: meta.model,
            updatedAt: stat.mtime,
            transcriptPath,
            continuationBlockedReason: "external-readonly",
        };
    } catch {
        return undefined;
    }
}

function updatedAt(session: SessionInfo): number {
    return session.updatedAt?.getTime() ?? 0;
}
