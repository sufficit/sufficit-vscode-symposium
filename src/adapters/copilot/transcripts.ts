import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryMessage, SessionInfo } from "../types";

function candidateWorkspaceStorageRoots(): string[] {
    const h = os.homedir();
    return [
        path.join(h, ".config", "Code", "User", "workspaceStorage"),
        path.join(h, ".local", "share", "code-server", "User", "workspaceStorage"),
    ];
}

function walkJsonl(dir: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { out.push(...walkJsonl(p)); }
        else if (e.isFile() && e.name.endsWith(".jsonl")) { out.push(p); }
    }
    return out;
}

export function copilotTranscriptFiles(): string[] {
    const files: string[] = [];
    for (const root of candidateWorkspaceStorageRoots()) {
        let workspaces: fs.Dirent[];
        try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const ws of workspaces) {
            if (!ws.isDirectory()) { continue; }
            const transcriptDir = path.join(root, ws.name, "GitHub.copilot-chat", "transcripts");
            files.push(...walkJsonl(transcriptDir));
        }
    }
    return [...new Set(files)];
}

function parseTimestamp(value: unknown): number | undefined {
    if (typeof value === "number") { return value; }
    if (typeof value === "string") {
        const t = Date.parse(value);
        return Number.isFinite(t) ? t : undefined;
    }
    return undefined;
}

function chatSessionTitle(file: string): string | undefined {
    try {
        let inputText = "";
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) { continue; }
            let j: any;
            try { j = JSON.parse(line); } catch { continue; }
            // kind 0 = session snapshot: inputState.inputText may or may not be set.
            if (j && j.kind === 0 && j.v) {
                const t = typeof j.v.inputState?.inputText === "string" ? j.v.inputState.inputText.trim() : "";
                if (t) { inputText = t; }
            }
            // kind 1 = incremental delta; text updates via ["inputState","inputText"] key.
            if (j && j.kind === 1 && Array.isArray(j.k)) {
                if (j.k.length === 2 && j.k[0] === "inputState" && (j.k[1] === "inputText" || j.k[1] === "value")) {
                    const v = typeof j.v === "string" ? j.v.trim() : "";
                    // Some code-server versions store a placeholder hash instead of real text on empty state.
                    if (v && v.length < 200 && /^[a-f0-9]+$/i.test(v)) { continue; }
                    if (v) { inputText = v; }
                }
            }
        }
        return inputText ? inputText.slice(0, 80) : undefined;
    } catch { return undefined; }
}

export function allCopilotSessions(): Map<string, { label: string; updatedTs: number; isTranscript: boolean }> {
    const map = new Map<string, { label: string; updatedTs: number; isTranscript: boolean }>();
    // Transcripts (full content, preferred)
    for (const file of copilotTranscriptFiles()) {
        const id = path.basename(file, ".jsonl");
        const info = transcriptSummary(file);
        if (info) {
            map.set(id, { label: info.title, updatedTs: info.updatedAt ? info.updatedAt.getTime() : 0, isTranscript: true });
        }
    }
    // chatSessions metadata (no-transcript sessions, fallback)
    for (const file of chatSessionsFiles()) {
        const id = path.basename(file, ".jsonl");
        if (map.has(id)) { continue; }  // transcripted session wins
        const label = chatSessionTitle(file);
        if (!label) { continue; }
        let updatedTs = 0;
        try {
            const stat = fs.statSync(file);
            updatedTs = stat.mtimeMs;
        } catch { /* ignore */ }
        map.set(id, { label, updatedTs, isTranscript: false });
    }
    return map;
}

function chatSessionsFiles(): string[] {
    const files: string[] = [];
    for (const root of candidateWorkspaceStorageRoots()) {
        let workspaces: fs.Dirent[];
        try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const ws of workspaces) {
            if (!ws.isDirectory()) { continue; }
            const dir = path.join(root, ws.name, "chatSessions");
            files.push(...walkJsonl(dir));
        }
    }
    return [...new Set(files)];
}

function transcriptSummary(file: string): SessionInfo | undefined {
    const sessionId = path.basename(file, ".jsonl");
    let title = "Copilot Chat";
    let firstUser = "";
    let updated = 0;
    try {
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) { continue; }
            let ev: any;
            try { ev = JSON.parse(line); } catch { continue; }
            const ts = parseTimestamp(ev.timestamp);
            if (ts && ts > updated) { updated = ts; }
            if (!firstUser && ev.type === "user.message") {
                const c = ev.data?.content;
                if (typeof c !== "string" || !c.trim()) { continue; }
                const clean = c.trim();
                // VS Code auto-summaries wrap the real prompt between tags.
                const summaryMatch = clean.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
                firstUser = summaryMatch ? summaryMatch[1].trim() : clean;
                title = firstUser.slice(0, 80);
            }
        }
        // No user.message found in transcript: try the chatSessions metadata.
        if (!firstUser) {
            for (const root of candidateWorkspaceStorageRoots()) {
                let workspaces: fs.Dirent[];
                try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
                for (const ws of workspaces) {
                    if (!ws.isDirectory()) { continue; }
                    const chatFile = path.join(root, ws.name, "chatSessions", sessionId + ".jsonl");
                    const cs = chatSessionTitle(chatFile);
                    if (cs) { title = cs; break; }
                }
                if (title !== "Copilot Chat") { break; }
            }
        }
    } catch { return undefined; }
    return {
        backend: "copilot",
        sessionId,
        title,
        updatedAt: updated ? new Date(updated) : undefined,
        transcriptPath: file,
    };
}

function parseToolArgs(raw: unknown): string | undefined {
    if (typeof raw !== "string" || !raw.trim()) { return undefined; }
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function toolDetail(name: string, args: string | undefined): string {
    if (!args) { return name; }
    try {
        const o = JSON.parse(args);
        return String(o.explanation || o.description || o.goal || o.command || o.filePath || o.path || o.query || name).slice(0, 160);
    } catch { return name; }
}

export function transcriptHistory(file: string): HistoryMessage[] {
    const out: HistoryMessage[] = [];
    try {
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
            if (!line.trim()) { continue; }
            let ev: any;
            try { ev = JSON.parse(line); } catch { continue; }
            const ts = parseTimestamp(ev.timestamp);
            if (ev.type === "user.message") {
                const content = ev.data?.content;
                if (typeof content === "string" && content.trim()) { out.push({ role: "user", text: content, ts }); }
                continue;
            }
            if (ev.type === "assistant.message") {
                const content = ev.data?.content;
                if (typeof content === "string" && content.trim()) { out.push({ role: "assistant", text: content, ts }); }
                for (const t of ev.data?.toolRequests ?? []) {
                    const name = String(t.name || "tool");
                    const input = parseToolArgs(t.arguments);
                    out.push({ role: "tool", text: name, toolName: name, detail: toolDetail(name, input), input, ts });
                }
                continue;
            }
        }
    } catch { /* ignore */ }
    return out;
}

function rmrf(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function deleteImportedCopilotSession(info: SessionInfo): string[] {
    const residual: string[] = [];
    const files = info.transcriptPath
        ? [info.transcriptPath]
        : copilotTranscriptFiles().filter((p) => path.basename(p, ".jsonl") === info.sessionId);
    for (const transcript of files) {
        rmrf(transcript);
        const wsRoot = transcript.split(`${path.sep}GitHub.copilot-chat${path.sep}`)[0];
        if (!wsRoot || wsRoot === transcript) { continue; }
        rmrf(path.join(wsRoot, "GitHub.copilot-chat", "debug-logs", info.sessionId));
        rmrf(path.join(wsRoot, "GitHub.copilot-chat", "chat-session-resources", info.sessionId));
        rmrf(path.join(wsRoot, "chatSessions", info.sessionId + ".jsonl"));
    }
    // Also remove any matching chatSessions file by id.
    for (const root of candidateWorkspaceStorageRoots()) {
        let workspaces: fs.Dirent[];
        try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const ws of workspaces) {
            if (!ws.isDirectory()) { continue; }
            rmrf(path.join(root, ws.name, "chatSessions", info.sessionId + ".jsonl"));
        }
    }
    if (!files.length) {
        residual.push("Copilot transcript not found; removed matching chatSessions entries only");
    }
    return residual;
}
