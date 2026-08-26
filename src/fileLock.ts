import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface LockOwner {
    token: string;
    pid: number;
    createdAt: number;
}

const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30_000;

/**
 * Runs one short filesystem transaction under a machine-wide lock.
 *
 * code-server starts one Extension Host per browser connection, while those
 * hosts share globalStorage. Atomic rename protects readers from partial JSON,
 * but it does not protect a read/merge/write transaction from lost updates.
 */
export function withFileLockSync<T>(file: string, action: () => T): T {
    const lockPath = `${file}.lock`;
    const owner: LockOwner = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            fs.mkdirSync(lockPath, { mode: 0o700 });
            fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), {
                encoding: "utf8",
                mode: 0o600,
            });
            break;
        } catch (error) {
            if (!isFsError(error, "EEXIST")) throw error;
            recoverStaleLock(lockPath);
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for shared file lock: ${file}`);
            }
            wait(LOCK_RETRY_MS);
        }
    }
    try {
        return action();
    } finally {
        release(lockPath, owner.token);
    }
}

function recoverStaleLock(lockPath: string): void {
    const owner = readOwner(lockPath);
    const stale = owner
        ? !pidAlive(owner.pid) || Date.now() - owner.createdAt >= LOCK_STALE_MS
        : lockAge(lockPath) >= LOCK_STALE_MS;
    if (!stale) return;
    try {
        fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
        // Another process may have recovered/replaced it first.
    }
}

function release(lockPath: string, token: string): void {
    if (readOwner(lockPath)?.token !== token) return;
    fs.rmSync(lockPath, { recursive: true, force: true });
}

function readOwner(lockPath: string): LockOwner | undefined {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
            token?: unknown;
            pid?: unknown;
            createdAt?: unknown;
        };
        if (
            typeof value.token === "string" &&
            typeof value.pid === "number" &&
            typeof value.createdAt === "number"
        ) {
            return value as LockOwner;
        }
    } catch {
        // mkdir and owner.json are two operations; a peer may observe the gap.
    }
    return undefined;
}

function lockAge(lockPath: string): number {
    try {
        return Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
        return 0;
    }
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !isFsError(error, "ESRCH");
    }
}

function wait(milliseconds: number): void {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, milliseconds);
}

function isFsError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
}
