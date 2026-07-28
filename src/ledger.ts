import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Session Ledger — a real, isolated git repo per session that mirrors EXACTLY
 * what is negotiated with the LLM and is never compacted.
 *
 * Layout: ~/.symposium/ledger/<sessionGuid>/  (one `git init` repo)
 *   messages.jsonl     full accumulated conversation (one JSON message per line)
 *   request-last.json  the literal request body last sent to the gateway
 *   meta.json          { id, backend, title, cwd, model, reasoning, updatedAt }
 *
 * One commit per turn → every past state is preserved (`git show <c>:messages.jsonl`),
 * so later context compaction never loses the original content.
 *
 * All operations are best-effort: a ledger failure must never break a chat turn.
 */

/** Runs git in a directory; resolves with code+stdout+stderr (never rejects). */
function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            const nodeError = err as { code?: number } | null;
            resolve({
                code: nodeError?.code !== undefined ? nodeError.code : err ? 1 : 0,
                stdout: String(stdout),
                stderr: String(stderr),
            });
        });
    });
}

export interface LedgerMessage {
    role: string;
    content: unknown;
    /** ISO timestamp recorded when this message entered the ledger (filled by appendMessage). */
    at?: string;
    /** Optional turn index (incremented per assistant turn). */
    turn?: number;
    /**
     * Event kind for non-message entries. "compaction" marks where the live model
     * context was summarized: the raw turns above stay in the ledger (lossless),
     * but the model only sees the summary from here on. Drives the "⊟ compacted
     * here" divider and lets readers distinguish a fold point from a real message.
     */
    kind?: "compaction" | string;
    [k: string]: unknown;
}

export interface LedgerMeta {
    id: string;
    backend: string;
    title?: string;
    cwd?: string;
    model?: string;
    reasoning?: string;
    updatedAt?: string;
    /**
     * Next logicalTurnId sequence number for this session (monotonic, survives
     * reload). Persisted here so a reopened session doesn't restart turn
     * numbering at 0. Reconstructed from the ledger as a fallback on resume.
     */
    nextTurnSeq?: number;
}

function ledgerRoot(): string {
    return path.join(os.homedir(), ".symposium", "ledger");
}

/** Persistent tombstones prevent a scrubbed session from being recovered by a stale ledger. */
function deletedSessionsFile(): string {
    return path.join(ledgerRoot(), ".deleted-sessions.json");
}

function deletedSessionIds(): Set<string> {
    try {
        const value = JSON.parse(fs.readFileSync(deletedSessionsFile(), "utf8"));
        return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
    } catch {
        return new Set();
    }
}

/** Whether this session was permanently deleted by Symposium. */
export function isLedgerDeleted(sessionId: string): boolean {
    return deletedSessionIds().has(sessionId);
}

/**
 * Records deletion before disk cleanup. This is deliberately durable: an old
 * process or delayed filesystem write must not make a permanently deleted
 * conversation reappear as a recovered session.
 */
export function markLedgerDeleted(sessionId: string): void {
    try {
        const ids = deletedSessionIds();
        if (ids.has(sessionId)) { return; }
        ids.add(sessionId);
        fs.mkdirSync(ledgerRoot(), { recursive: true });
        const target = deletedSessionsFile();
        const temp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify([...ids]));
        fs.renameSync(temp, target);
    } catch { /* best-effort: the physical scrub still runs */ }
}

/** Absolute path of a session's ledger repo. */
export function ledgerDir(sessionId: string): string {
    return path.join(ledgerRoot(), sessionId);
}

function messagesFile(dir: string): string { return path.join(dir, "messages.jsonl"); }
function requestFile(dir: string): string { return path.join(dir, "request-last.json"); }
function metaFile(dir: string): string { return path.join(dir, "meta.json"); }

/**
 * Ensures the session's ledger repo exists and is initialised with an isolated
 * git identity that never touches the user's config or hooks.
 */
export async function ensureLedger(sessionId: string, meta: LedgerMeta): Promise<string | undefined> {
    if (isLedgerDeleted(sessionId)) { return undefined; }
    const dir = ledgerDir(sessionId);
    try {
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(path.join(dir, ".git"))) {
            const init = await git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
            if (init.code !== 0) { return undefined; }
            // Per-repo identity + total isolation from the user's environment.
            await git(dir, ["config", "user.name", "Symposium"]);
            await git(dir, ["config", "user.email", "symposium@local"]);
            await git(dir, ["config", "commit.gpgsign", "false"]);
            await git(dir, ["config", "core.hooksPath", "/dev/null"]);
            if (!fs.existsSync(messagesFile(dir))) { fs.writeFileSync(messagesFile(dir), ""); }
            writeMetaDir(dir, meta);
        } else {
            writeMetaDir(dir, meta);
        }
        return dir;
    } catch {
        return undefined;
    }
}

function writeMetaDir(dir: string, meta: LedgerMeta): void {
    try {
        const existing = readMetaDir(dir);
        const merged: LedgerMeta = { ...existing, ...meta, updatedAt: new Date().toISOString() };
        fs.writeFileSync(metaFile(dir), JSON.stringify(merged, null, 2));
    } catch { /* best-effort */ }
}

function readMetaDir(dir: string): LedgerMeta | undefined {
    try { return JSON.parse(fs.readFileSync(metaFile(dir), "utf8")); } catch { return undefined; }
}

/**
 * Merges partial meta into the session's `meta.json` (public, session-id keyed
 * wrapper around the internal dir-based writer). Used to persist transient
 * session state — e.g. advancing the logicalTurnId sequence — outside the
 * `ensureLedger` path. Best-effort: never throws on a missing/corrupt ledger.
 */
export function writeMeta(sessionId: string, meta: Partial<LedgerMeta>): void {
    if (isLedgerDeleted(sessionId)) { return; }
    try { writeMetaDir(ledgerDir(sessionId), { ...(readMetaDir(ledgerDir(sessionId)) ?? { id: sessionId, backend: "" }), ...meta } as LedgerMeta); } catch { /* best-effort */ }
}

/** Reads the session's merged `meta.json`, or undefined when absent/corrupt. */
export function readMeta(sessionId: string): LedgerMeta | undefined {
    try { return readMetaDir(ledgerDir(sessionId)); } catch { return undefined; }
}

/** Appends one message to the session ledger (append-only, never rewrites). */
export function appendMessage(sessionId: string, msg: LedgerMessage): void {
    if (isLedgerDeleted(sessionId)) { return; }
    try {
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({ ...msg, at: msg.at ?? new Date().toISOString() });
        fs.appendFileSync(messagesFile(dir), line + "\n");
    } catch { /* best-effort */ }
}

/**
 * Epoch ms of the ledger's last entry (any role) — the true "last activity"
 * time for the session, regardless of how the previous turn ended. Feeds the
 * time-gap notice (see OpenAISession.send): read once per new user message,
 * not per hop, so the cost of scanning the file is bounded by turn count.
 */
export function lastMessageAtMs(sessionId: string): number | undefined {
    try {
        const raw = fs.readFileSync(messagesFile(ledgerDir(sessionId)), "utf8");
        const lines = raw.split("\n").filter((l) => l.trim());
        if (!lines.length) { return undefined; }
        const last = JSON.parse(lines[lines.length - 1]) as { at?: string };
        const ms = last.at ? Date.parse(last.at) : NaN;
        return Number.isFinite(ms) ? ms : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Records the LITERAL request body sent to the gateway this turn — the absolute
 * truth of what the LLM received (system/developer/user + tools + model + effort).
 */
export function recordRequest(sessionId: string, body: unknown, attemptId?: string): void {
    if (isLedgerDeleted(sessionId)) { return; }
    try {
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        // Wrap with the attempt id (when provided) so the persisted request is
        // attributable to a specific model POST within a logical turn, without
        // mutating the gateway payload itself.
        const envelope = attemptId ? { attemptId, body } : body;
        fs.writeFileSync(requestFile(dir), JSON.stringify(envelope, null, 2));
    } catch { /* best-effort */ }
}

/** Commits the current ledger state as one immutable snapshot for this turn. */
export async function commitTurn(sessionId: string, message: string): Promise<void> {
    if (isLedgerDeleted(sessionId)) { return; }
    try {
        const dir = ledgerDir(sessionId);
        if (!fs.existsSync(path.join(dir, ".git"))) { return; }
        await git(dir, ["add", "-A"]);
        const status = await git(dir, ["status", "--porcelain"]);
        if (!status.stdout.trim()) { return; } // nothing changed
        await git(dir, ["commit", "-q", "--no-verify", "-m", message]);
    } catch { /* best-effort */ }
}

/** Reads the full accumulated message history from the ledger (lossless). */
export function readMessages(sessionId: string): LedgerMessage[] {
    try {
        const raw = fs.readFileSync(messagesFile(ledgerDir(sessionId)), "utf8");
        const out: LedgerMessage[] = [];
        for (const line of raw.split("\n")) {
            const t = line.trim();
            if (!t) { continue; }
            try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
        }
        return out;
    } catch {
        return [];
    }
}

/** True if a ledger repo exists for this session. */
export function hasLedger(sessionId: string): boolean {
    if (isLedgerDeleted(sessionId)) { return false; }
    try { return fs.existsSync(path.join(ledgerDir(sessionId), ".git")); } catch { return false; }
}

/** The commit timeline (newest first): [{ hash, date, subject }]. */
export async function timeline(sessionId: string): Promise<{ hash: string; date: string; subject: string }[]> {
    try {
        const dir = ledgerDir(sessionId);
        if (!fs.existsSync(path.join(dir, ".git"))) { return []; }
        const r = await git(dir, ["log", "--pretty=%H%x1f%aI%x1f%s"]);
        if (r.code !== 0) { return []; }
        return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
            const [hash, date, subject] = l.split("\x1f");
            return { hash, date, subject };
        });
    } catch {
        return [];
    }
}

/** Permanently removes a session's ledger repo (secure delete / scrub). */
export function removeLedger(sessionId: string): void {
    try { fs.rmSync(ledgerDir(sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Lists ALL sessions known to the ledger (scans the ledger root directory).
 * Each entry is reconstructed from the session's `meta.json`. Used to recover
 * "orphan" sessions that have a ledger but no store file (e.g. sessions created
 * before the constructor-persist fix, or sessions whose store was deleted).
 */
export function listLedgerSessions(): LedgerMeta[] {
    const root = ledgerRoot();
    const deleted = deletedSessionIds();
    let entries: string[];
    try { entries = fs.readdirSync(root).filter((e) => fs.statSync(path.join(root, e)).isDirectory()); } catch { return []; }
    const out: LedgerMeta[] = [];
    for (const sessionId of entries) {
        if (deleted.has(sessionId)) { continue; }
        const meta = readMetaDir(ledgerDir(sessionId));
        if (meta) { out.push(meta); }
    }
    return out;
}
