import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionInfo } from "../types";
import { readGeminiMeta } from "./transcript";

/** Discovers Gemini / Antigravity transcripts and reuses unchanged metadata. */
export async function listGeminiSessions(cached: readonly SessionInfo[]): Promise<SessionInfo[]> {
    const cachedByPath = new Map(
        cached.filter((item) => item.transcriptPath).map((item) => [item.transcriptPath!, item]),
    );

    const brainRoot = path.join(os.homedir(), ".gemini", "antigravity-ide", "brain");
    const sessions: SessionInfo[] = [];

    await scanBrainDir(brainRoot, cachedByPath, sessions);

    const historyRoot = path.join(os.homedir(), ".gemini", "history");
    await scanHistoryDir(historyRoot, cachedByPath, sessions);

    sessions.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    return sessions.slice(0, 50);
}

async function scanBrainDir(
    brainRoot: string,
    cachedByPath: ReadonlyMap<string, SessionInfo>,
    out: SessionInfo[],
): Promise<void> {
    let convDirs: string[];
    try {
        convDirs = await fs.promises.readdir(brainRoot);
    } catch {
        return;
    }

    for (const convId of convDirs) {
        const transcriptPath = path.join(
            brainRoot,
            convId,
            ".system_generated",
            "logs",
            "transcript.jsonl",
        );
        try {
            const stat = await fs.promises.stat(transcriptPath);
            const cachedInfo = cachedByPath.get(transcriptPath);
            if (cachedInfo?.updatedAt?.getTime() === stat.mtime.getTime()) {
                out.push(cachedInfo);
                continue;
            }
            const meta = await readGeminiMeta(transcriptPath);
            out.push({
                backend: "gemini",
                sessionId: convId,
                title: meta.title ?? `Gemini Session ${convId.slice(0, 8)}`,
                cwd: meta.cwd,
                model: meta.model,
                updatedAt: stat.mtime,
                transcriptPath,
            });
        } catch {
            /* skip missing or unreadable transcripts */
        }
    }
}

async function scanHistoryDir(
    historyRoot: string,
    cachedByPath: ReadonlyMap<string, SessionInfo>,
    out: SessionInfo[],
): Promise<void> {
    let entries: string[];
    try {
        entries = await fs.promises.readdir(historyRoot);
    } catch {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(historyRoot, entry);
        try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.isFile() && entry.endsWith(".jsonl")) {
                const cachedInfo = cachedByPath.get(fullPath);
                if (cachedInfo?.updatedAt?.getTime() === stat.mtime.getTime()) {
                    out.push(cachedInfo);
                    continue;
                }
                const meta = await readGeminiMeta(fullPath);
                const sessionId = path.basename(entry, ".jsonl");
                out.push({
                    backend: "gemini",
                    sessionId,
                    title: meta.title ?? `Gemini ${sessionId.slice(0, 8)}`,
                    cwd: meta.cwd,
                    model: meta.model,
                    updatedAt: stat.mtime,
                    transcriptPath: fullPath,
                });
            }
        } catch {
            /* ignore unreadable entries */
        }
    }
}
