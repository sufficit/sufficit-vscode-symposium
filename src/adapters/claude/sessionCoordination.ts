import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface LeaseOwner {
    pid: number;
    token: string;
    startedAt: string;
}

interface CoordinationState {
    generation: number;
    updatedAt: string;
}

export interface ClaudeSessionCoordinationOptions {
    root?: string;
    pid?: number;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    log?: (message: string) => void;
}

export type ClaudeSessionLeaseResult =
    | { acquired: true; generation: number; recoveredStaleOwner: boolean }
    | { acquired: false; ownerPid?: number; message: string };

const OWNER_GRACE_MS = 30_000;

/** Coordinates writable Claude resumes across code-server Extension Hosts. */
export class ClaudeSessionCoordination {
    private readonly token = randomUUID();
    private readonly root: string;
    private readonly pid: number;
    private readonly now: () => number;
    private readonly isPidAlive: (pid: number) => boolean;
    private readonly log?: (message: string) => void;
    private held:
        | { sessionId: string; lockPath: string; statePath: string; generation: number }
        | undefined;

    constructor(options: ClaudeSessionCoordinationOptions = {}) {
        const uid = typeof process.getuid === "function" ? process.getuid() : "user";
        this.root = options.root ?? path.join(os.tmpdir(), `symposium-${uid}-claude-coordination`);
        this.pid = options.pid ?? process.pid;
        this.now = options.now ?? Date.now;
        this.isPidAlive = options.isPidAlive ?? pidIsAlive;
        this.log = options.log;
    }

    acquire(sessionId: string): ClaudeSessionLeaseResult {
        if (this.held?.sessionId === sessionId) {
            return {
                acquired: true,
                generation: this.held.generation,
                recoveredStaleOwner: false,
            };
        }
        if (this.held) {
            this.release();
        }
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const key = createHash("sha256").update(sessionId).digest("hex");
        const lockPath = path.join(this.root, `${key}.lock`);
        const statePath = path.join(this.root, `${key}.json`);
        let recoveredStaleOwner = false;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            let createdLock = false;
            try {
                fs.mkdirSync(lockPath, { mode: 0o700 });
                createdLock = true;
                const generation = readGeneration(statePath);
                const owner: LeaseOwner = {
                    pid: this.pid,
                    token: this.token,
                    startedAt: new Date(this.now()).toISOString(),
                };
                fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf8");
                this.held = { sessionId, lockPath, statePath, generation };
                return { acquired: true, generation, recoveredStaleOwner };
            } catch (error) {
                if (!isFsError(error, "EEXIST")) {
                    if (createdLock) {
                        fs.rmSync(lockPath, { recursive: true, force: true });
                    } else {
                        this.removeOwnedLock(lockPath);
                    }
                    return {
                        acquired: false,
                        message: `Claude session coordination failed: ${errorMessage(error)}`,
                    };
                }
            }

            const existing = readOwner(lockPath);
            if (existing && this.isPidAlive(existing.pid)) {
                return {
                    acquired: false,
                    ownerPid: existing.pid,
                    message:
                        `This Claude session is already running in another code-server window ` +
                        `(extension host PID ${existing.pid}). Wait for that turn to finish, then retry.`,
                };
            }
            if (!existing && !lockIsStale(lockPath, this.now())) {
                return {
                    acquired: false,
                    message:
                        "This Claude session is being opened in another code-server window. " +
                        "Wait a moment, then retry.",
                };
            }
            fs.rmSync(lockPath, { recursive: true, force: true });
            recoveredStaleOwner = true;
            this.log?.(`[claude] recovered stale cross-window lease for ${sessionId}`);
        }

        return {
            acquired: false,
            message: "Could not acquire the Claude session after recovering its stale owner.",
        };
    }

    release(): number | undefined {
        const held = this.held;
        this.held = undefined;
        if (!held) {
            return undefined;
        }
        const owner = readOwner(held.lockPath);
        if (!owner || owner.token !== this.token || owner.pid !== this.pid) {
            this.log?.(`[claude] cross-window lease ownership changed for ${held.sessionId}`);
            return undefined;
        }
        const generation = Math.max(held.generation, readGeneration(held.statePath)) + 1;
        try {
            writeGeneration(held.statePath, generation, this.pid, this.token, this.now());
        } catch (error) {
            this.log?.(`[claude] coordination generation write failed: ${errorMessage(error)}`);
        } finally {
            fs.rmSync(held.lockPath, { recursive: true, force: true });
        }
        return generation;
    }

    private removeOwnedLock(lockPath: string): void {
        const owner = readOwner(lockPath);
        if (owner?.token === this.token && owner.pid === this.pid) {
            fs.rmSync(lockPath, { recursive: true, force: true });
        }
    }
}

function readOwner(lockPath: string): LeaseOwner | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
            pid?: unknown;
            token?: unknown;
            startedAt?: unknown;
        };
        if (
            typeof parsed.pid === "number" &&
            typeof parsed.token === "string" &&
            typeof parsed.startedAt === "string"
        ) {
            return parsed as LeaseOwner;
        }
    } catch {
        // The creating process may still be between mkdir and owner.json.
    }
    return undefined;
}

function readGeneration(statePath: string): number {
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as CoordinationState;
        return Number.isSafeInteger(parsed.generation) && parsed.generation >= 0
            ? parsed.generation
            : 0;
    } catch {
        return 0;
    }
}

function writeGeneration(
    statePath: string,
    generation: number,
    pid: number,
    token: string,
    now: number,
): void {
    const temporary = `${statePath}.${pid}.${token}.tmp`;
    const state: CoordinationState = { generation, updatedAt: new Date(now).toISOString() };
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, statePath);
}

function lockIsStale(lockPath: string, now: number): boolean {
    try {
        return now - fs.statSync(lockPath).mtimeMs >= OWNER_GRACE_MS;
    } catch {
        return false;
    }
}

function pidIsAlive(pid: number): boolean {
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
