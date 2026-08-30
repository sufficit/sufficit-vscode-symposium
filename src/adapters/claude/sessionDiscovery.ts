import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionInfo } from "../types";
import { readSessionMeta } from "./transcript";

/** Incrementally discovers Claude Code transcripts and reuses unchanged metadata. */
export async function listClaudeSessions(cached: readonly SessionInfo[]): Promise<SessionInfo[]> {
    const root = path.join(os.homedir(), ".claude", "projects");
    const cachedByPath = new Map(
        cached.filter((item) => item.transcriptPath).map((item) => [item.transcriptPath!, item]),
    );
    const sessions: SessionInfo[] = [];
    let projectDirs: string[];
    try {
        projectDirs = await fs.promises.readdir(root);
    } catch {
        return sessions;
    }
    for (const dir of projectDirs) {
        const projectPath = path.join(root, dir);
        let files: string[];
        try {
            files = await fs.promises.readdir(projectPath);
        } catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith(".jsonl")) {
                continue;
            }
            const fullPath = path.join(projectPath, file);
            try {
                const stat = await fs.promises.stat(fullPath);
                const cachedInfo = cachedByPath.get(fullPath);
                if (cachedInfo?.updatedAt?.getTime() === stat.mtime.getTime()) {
                    sessions.push(cachedInfo);
                    continue;
                }
                const meta = await readSessionMeta(fullPath);
                sessions.push({
                    backend: "claude",
                    sessionId: path.basename(file, ".jsonl"),
                    title: meta.title ?? dir,
                    cwd: meta.cwd,
                    gitBranch: meta.gitBranch,
                    lineageId: meta.originSessionId,
                    model: meta.model,
                    reasoning: meta.reasoning,
                    updatedAt: stat.mtime,
                    transcriptPath: fullPath,
                });
            } catch {
                /* unreadable session files are skipped */
            }
        }
        sessions.push(...(await listSubagentSessions(projectPath, cachedByPath)));
    }
    sessions.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    return sessions.slice(0, 50);
}

async function listSubagentSessions(
    projectPath: string,
    cachedByPath: ReadonlyMap<string, SessionInfo>,
): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    let parentDirs: string[];
    try {
        parentDirs = await fs.promises.readdir(projectPath);
    } catch {
        return out;
    }
    for (const parentId of parentDirs) {
        if (!/^[0-9a-f-]{36}$/i.test(parentId)) {
            continue;
        }
        const subagentsDir = path.join(projectPath, parentId, "subagents");
        let files: string[];
        try {
            files = await fs.promises.readdir(subagentsDir);
        } catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith(".jsonl")) {
                continue;
            }
            const fullPath = path.join(subagentsDir, file);
            try {
                const stat = await fs.promises.stat(fullPath);
                const cachedInfo = cachedByPath.get(fullPath);
                if (cachedInfo?.updatedAt?.getTime() === stat.mtime.getTime()) {
                    out.push(cachedInfo);
                    continue;
                }
                const meta = await readSessionMeta(fullPath);
                const agentId = path.basename(file, ".jsonl");
                out.push({
                    backend: "claude",
                    sessionId: `${parentId}/subagents/${agentId}`,
                    title: meta.title ?? `Subagent: ${agentId}`,
                    cwd: meta.cwd,
                    gitBranch: meta.gitBranch,
                    parentId,
                    lineageId: parentId,
                    model: meta.model,
                    reasoning: meta.reasoning,
                    updatedAt: stat.mtime,
                    transcriptPath: fullPath,
                });
            } catch {
                /* unreadable subagent transcript files are skipped */
            }
        }
    }
    return out;
}
