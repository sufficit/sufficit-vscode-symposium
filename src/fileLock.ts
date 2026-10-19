import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface LockOwner {
    token: string;
    hostname?: string;
    pid: number;
    createdAt: number;
    updatedAt?: number;
}

// Allow sibling hosts to finish large snapshots on slower shared filesystems.
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30_000;

/**
 * Runs one filesystem transaction under a machine-wide lock without blocking
 * the extension-host event loop.
 *
 * code-server starts one Extension Host per browser connection, while those
 * hosts share globalStorage. Atomic rename protects readers from partial JSON,
 * but it does not protect a read/merge/write transaction from lost updates.
 * The owner file is heartbeated while the action runs so a slow but live
 * transaction is never treated as stale; a crashed owner (dead pid or no
 * heartbeat for LOCK_STALE_MS) is recovered by exactly one contender.
 */
export async function withFileLock<T>(file: string, action: () => Promise<T> | T): Promise<T> {
    const lockPath = `${file}.lock`;
    const owner: Required<LockOwner> = {
        token: randomUUID(),
        hostname: os.hostname(),
        pid: process.pid,
        // Set only after this contender has actually acquired the directory.
        createdAt: 0,
        updatedAt: 0,
    };
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        let created = false;
        try {
            await fs.promises.mkdir(lockPath, { mode: 0o700 });
            created = true;
            owner.createdAt = Date.now();
            owner.updatedAt = owner.createdAt;
            await fs.promises.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), {
                encoding: "utf8",
                mode: 0o600,
            });
            break;
        } catch (error) {
            if (created) {
                await fs.promises
                    .rm(lockPath, { recursive: true, force: true })
                    .catch(() => undefined);
            }
            if (!isFsError(error, "EEXIST")) throw error;
            await recoverStaleLockAsync(lockPath);
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for shared file lock: ${file}`);
            }
            await delay(LOCK_RETRY_MS);
        }
    }

    let heartbeat = Promise.resolve();
    const timer = setInterval(
        () => {
            owner.updatedAt = Date.now();
            heartbeat = heartbeat.then(async () => {
                try {
                    // The owner check is only advisory: the directory could be replaced
                    // immediately after it. Write a token-scoped lease file so a resumed
                    // heartbeat can never rename over a successor's owner.json.
                    const current = await readOwnerAsync(lockPath);
                    if (current?.token !== owner.token) return;
                    await writeFileLockHeartbeat(lockPath, owner.token, owner.updatedAt);
                } catch {
                    // Heartbeats are best effort; recovery expires the lease if they fail.
                }
            });
        },
        Math.max(1_000, Math.floor(LOCK_STALE_MS / 3)),
    );
    timer.unref();
    try {
        return await action();
    } finally {
        clearInterval(timer);
        await heartbeat;
        const current = await readOwnerAsync(lockPath);
        if (current?.token === owner.token) {
            // A failed release must not mask the action's result; the lock expires on its own.
            await fs.promises.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

async function recoverStaleLockAsync(lockPath: string): Promise<void> {
    const recoveryPath = `${lockPath}.recover`;
    try {
        await fs.promises.mkdir(recoveryPath, { mode: 0o700 });
    } catch (error) {
        if (isFsError(error, "EEXIST")) {
            // A contender that died mid-recovery would otherwise block every
            // later recovery forever; expire its marker like a stale lock.
            if ((await lockAgeAsync(recoveryPath)) >= LOCK_STALE_MS) {
                await fs.promises
                    .rm(recoveryPath, { recursive: true, force: true })
                    .catch(() => undefined);
            }
            return;
        }
        if (isFsError(error, "ENOENT")) return;
        throw error;
    }
    try {
        const owner = await readOwnerAsync(lockPath);
        const heartbeatAt = owner ? await readHeartbeatAsync(lockPath, owner.token) : undefined;
        const lastSeenAt = heartbeatAt ?? owner?.updatedAt ?? owner?.createdAt;
        const stale = owner
            ? sameHost(owner)
                ? !pidAlive(owner.pid)
                : lastSeenAt !== undefined && Date.now() - lastSeenAt >= LOCK_STALE_MS
            : (await lockAgeAsync(lockPath)) >= LOCK_STALE_MS;
        if (stale) await fs.promises.rm(lockPath, { recursive: true, force: true });
    } finally {
        await fs.promises.rm(recoveryPath, { recursive: true, force: true });
    }
}

/** Writes a lease update without ever replacing owner.json. Exported for focused race tests. */
export async function writeFileLockHeartbeat(
    lockPath: string,
    token: string,
    updatedAt: number,
): Promise<void> {
    const heartbeatPath = path.join(lockPath, `heartbeat.${token}.json`);
    const temporary = path.join(lockPath, `heartbeat.${token}.${randomUUID()}.tmp`);
    try {
        await fs.promises.writeFile(temporary, JSON.stringify({ token, updatedAt }), {
            mode: 0o600,
        });
        await fs.promises.rename(temporary, heartbeatPath);
    } catch {
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    }
}

async function readHeartbeatAsync(lockPath: string, token: string): Promise<number | undefined> {
    try {
        const value = JSON.parse(
            await fs.promises.readFile(path.join(lockPath, `heartbeat.${token}.json`), "utf8"),
        ) as { token?: unknown; updatedAt?: unknown };
        if (value.token === token && typeof value.updatedAt === "number") return value.updatedAt;
    } catch {
        // The owner may not have emitted its first heartbeat yet.
    }
    return undefined;
}

async function readOwnerAsync(lockPath: string): Promise<LockOwner | undefined> {
    try {
        const value = JSON.parse(
            await fs.promises.readFile(path.join(lockPath, "owner.json"), "utf8"),
        ) as {
            token?: unknown;
            hostname?: unknown;
            pid?: unknown;
            createdAt?: unknown;
            updatedAt?: unknown;
        };
        if (
            typeof value.token === "string" &&
            typeof value.pid === "number" &&
            (value.hostname === undefined || typeof value.hostname === "string") &&
            typeof value.createdAt === "number" &&
            (value.updatedAt === undefined || typeof value.updatedAt === "number")
        )
            return value as LockOwner;
    } catch {
        // A peer may observe mkdir before owner.json is written.
    }
    return undefined;
}

async function lockAgeAsync(lockPath: string): Promise<number> {
    try {
        return Date.now() - (await fs.promises.stat(lockPath)).mtimeMs;
    } catch {
        return 0;
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** PID liveness is meaningful only on the host that wrote the lock (legacy owners have no host). */
function sameHost(owner: LockOwner): boolean {
    return owner.hostname === undefined || owner.hostname === os.hostname();
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !isFsError(error, "ESRCH");
    }
}

function isFsError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
}
