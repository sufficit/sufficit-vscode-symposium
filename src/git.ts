import { execFile } from "child_process";
import * as fs from "fs";

/** Runs git in a directory; resolves with code+stdout+stderr (never rejects). */
function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

/** Repository root for a directory, or undefined if not in a git repo. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
    const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return r.code === 0 ? r.stdout.trim() : undefined;
}

/** True if the path is tracked by git (exists at HEAD or index). */
export async function isTracked(cwd: string, abs: string): Promise<boolean> {
    const r = await git(cwd, ["ls-files", "--error-unmatch", "--", abs]);
    return r.code === 0;
}

/** File content at HEAD, or undefined if the file is untracked/new. */
export async function headContent(cwd: string, abs: string): Promise<string | undefined> {
    const root = await gitRoot(cwd);
    if (!root) { return undefined; }
    const rel = require("path").relative(root, abs).split(require("path").sep).join("/");
    const r = await git(root, ["show", `HEAD:${rel}`]);
    return r.code === 0 ? r.stdout : undefined;
}

/**
 * Rejects an agent change: a tracked file is restored to HEAD; an untracked
 * (newly created) file is deleted. Returns true on success.
 */
export async function rejectChange(cwd: string, abs: string): Promise<boolean> {
    if (await isTracked(cwd, abs)) {
        // Drop both staged and working-tree changes for this path.
        const a = await git(cwd, ["restore", "--staged", "--worktree", "--", abs]);
        if (a.code !== 0) {
            // Older git: fall back to checkout.
            const b = await git(cwd, ["checkout", "HEAD", "--", abs]);
            return b.code === 0;
        }
        return true;
    }
    try { await fs.promises.unlink(abs); return true; } catch { return false; }
}

/** Approves a change by staging it (git add). Returns true on success. */
export async function approveChange(cwd: string, abs: string): Promise<boolean> {
    const r = await git(cwd, ["add", "--", abs]);
    return r.code === 0;
}

/**
 * Of the given absolute paths, the ones that still have UNSTAGED or untracked
 * changes (so they're "pending review"). A file that's fully staged drops out;
 * unstaging it in git brings it back. Paths not inside any git repo are treated
 * as always-pending (their lifecycle is handled by snapshots instead).
 */
export async function pendingChanges(absPaths: string[]): Promise<Set<string>> {
    const pending = new Set<string>();
    const path = require("path") as typeof import("path");
    // Group paths by their repo root (or "" when not in a repo).
    const byRepo = new Map<string, string[]>();
    for (const abs of absPaths) {
        const root = (await gitRoot(path.dirname(abs))) ?? "";
        const list = byRepo.get(root) ?? [];
        list.push(abs);
        byRepo.set(root, list);
    }
    for (const [root, paths] of byRepo) {
        if (!root) {
            // Non-git: always pending (snapshot-resolved elsewhere).
            for (const p of paths) { pending.add(p); }
            continue;
        }
        const r = await git(root, ["status", "--porcelain", "--no-renames"]);
        if (r.code !== 0) { for (const p of paths) { pending.add(p); } continue; }
        const dirty = new Set<string>();
        for (const line of r.stdout.split("\n")) {
            if (line.length < 4) { continue; }
            const x = line[0], y = line[1];
            const rel = line.slice(3).trim();
            // Untracked, or any working-tree change (2nd column != space).
            const isPending = (x === "?" && y === "?") || (y !== " ");
            if (isPending && rel) { dirty.add(path.resolve(root, rel)); }
        }
        for (const p of paths) { if (dirty.has(p)) { pending.add(p); } }
    }
    return pending;
}
