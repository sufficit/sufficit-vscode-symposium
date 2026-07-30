import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionInfo } from "../types";
import { inferCodexLineage, readCodexMeta } from "./transcript";

/** Incrementally discovers Codex rollouts and reuses unchanged metadata. */
export async function listCodexSessions(cached: readonly SessionInfo[]): Promise<SessionInfo[]> {
    const root = path.join(os.homedir(), ".codex", "sessions");
    const cachedByPath = new Map(cached
        .filter((item) => item.transcriptPath)
        .map((item) => [item.transcriptPath!, item]));
    const files: string[] = [];
    await walkRollouts(root, 0, files);

    const records: { info: SessionInfo; seedHistory?: string }[] = [];
    for (const file of files) {
        try {
            const stat = await fs.promises.stat(file);
            const cachedInfo = cachedByPath.get(file);
            if (cachedInfo?.updatedAt?.getTime() === stat.mtime.getTime()) {
                records.push({ info: cachedInfo });
                continue;
            }
            const meta = await readCodexMeta(file);
            if (!meta.id) { continue; }
            records.push({ info: {
                backend: "codex",
                sessionId: meta.id,
                title: meta.title ?? path.basename(file),
                model: meta.model,
                lineageId: meta.lineageId,
                parentId: meta.parentId,
                continuationBlockedReason: meta.continuationBlockedReason,
                cwd: meta.cwd,
                updatedAt: stat.mtime,
                transcriptPath: file,
            }, seedHistory: meta.seedHistory });
        } catch { /* skip unreadable files */ }
    }

    for (const record of records) {
        if (record.info.parentId || !record.seedHistory) { continue; }
        const lineage = inferCodexLineage(record.seedHistory, records
            .filter((candidate) => candidate !== record)
            .map((candidate) => ({
                sessionId: candidate.info.sessionId,
                lineageId: candidate.info.lineageId,
                historyText: candidate.seedHistory ?? "",
            })));
        if (!lineage) { continue; }
        record.info.lineageId = lineage;
    }
    return records.map((record) => record.info).sort((a, b) =>
        (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
}

async function walkRollouts(dir: string, depth: number, files: string[]): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) {
            await walkRollouts(full, depth + 1, files);
        } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
            files.push(full);
        }
    }
}