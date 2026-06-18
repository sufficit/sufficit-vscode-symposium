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
            resolve({
                code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0,
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
}

function ledgerRoot(): string {
    return path.join(os.homedir(), ".symposium", "ledger");
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
            writeMeta(dir, meta);
        } else {
            writeMeta(dir, meta);
        }
        return dir;
    } catch {
        return undefined;
    }
}

function writeMeta(dir: string, meta: LedgerMeta): void {
    try {
        const existing = readMetaFrom(dir);
        const merged: LedgerMeta = { ...existing, ...meta, updatedAt: new Date().toISOString() };
        fs.writeFileSync(metaFile(dir), JSON.stringify(merged, null, 2));
    } catch { /* best-effort */ }
}

function readMetaFrom(dir: string): LedgerMeta | undefined {
    try { return JSON.parse(fs.readFileSync(metaFile(dir), "utf8")); } catch { return undefined; }
}

/** Appends one message to the session ledger (append-only, never rewrites). */
export function appendMessage(sessionId: string, msg: LedgerMessage): void {
    try {
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({ ...msg, at: msg.at ?? new Date().toISOString() });
        fs.appendFileSync(messagesFile(dir), line + "\n");
    } catch { /* best-effort */ }
}

/**
 * Records the LITERAL request body sent to the gateway this turn — the absolute
 * truth of what the LLM received (system/developer/user + tools + model + effort).
 */
export function recordRequest(sessionId: string, body: unknown): void {
    try {
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(requestFile(dir), JSON.stringify(body, null, 2));
    } catch { /* best-effort */ }
}

/** Commits the current ledger state as one immutable snapshot for this turn. */
export async function commitTurn(sessionId: string, message: string): Promise<void> {
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
