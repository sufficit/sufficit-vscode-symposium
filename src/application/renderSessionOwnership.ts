import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RenderWriter } from "../renderLog";

interface OwnershipRecord extends RenderWriter {
    protocol: number;
    startedAt: string;
}

export interface RenderSessionOwnershipOptions {
    root?: string;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    log?: (message: string) => void;
}

const OWNER_GRACE_MS = 30_000;
export const RENDER_OWNER_PROTOCOL = 2;

/**
 * Elects one controller as the writable owner of a native session while every
 * other Extension Host remains a read/write queue client of that owner.
 * Ownership lasts for the controller lifetime, so an idle peer can accept a
 * message queued from another browser without two adapters resuming at once.
 */
export class RenderSessionOwnership {
    private readonly root: string;
    private readonly now: () => number;
    private readonly isPidAlive: (pid: number) => boolean;
    private readonly log?: (message: string) => void;
    private held: { sessionId: string; lockPath: string } | undefined;

    constructor(
        private readonly writer: RenderWriter,
        options: RenderSessionOwnershipOptions = {},
    ) {
        const uid = typeof process.getuid === "function" ? process.getuid() : "user";
        this.root = options.root ?? path.join(os.tmpdir(), `symposium-${uid}-render-owners`);
        this.now = options.now ?? Date.now;
        this.isPidAlive = options.isPidAlive ?? pidIsAlive;
        this.log = options.log;
    }

    owns(sessionId: string): boolean {
        const held = this.held;
        if (held?.sessionId !== sessionId) return false;
        const owner = readOwner(held.lockPath);
        if (owner?.id === this.writer.id && owner.pid === this.writer.pid) return true;
        this.held = undefined;
        this.log?.(`[render-owner] ownership changed for ${sessionId}`);
        return false;
    }

    /** Acquires a missing/stale owner lock, or reports that a live peer owns it. */
    ensure(sessionId: string): boolean {
        if (!sessionId) return true;
        if (this.owns(sessionId)) return true;
        if (this.held) this.release();
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const key = createHash("sha256").update(sessionId).digest("hex");
        const lockPath = path.join(this.root, `${key}.lock`);

        for (let attempt = 0; attempt < 2; attempt += 1) {
            let created = false;
            try {
                fs.mkdirSync(lockPath, { mode: 0o700 });
                created = true;
                const record: OwnershipRecord = {
                    ...this.writer,
                    protocol: RENDER_OWNER_PROTOCOL,
                    startedAt: new Date(this.now()).toISOString(),
                };
                fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(record), {
                    encoding: "utf8",
                    mode: 0o600,
                });
                this.held = { sessionId, lockPath };
                return true;
            } catch (error) {
                if (!isFsError(error, "EEXIST")) {
                    if (created) fs.rmSync(lockPath, { recursive: true, force: true });
                    this.log?.(
                        `[render-owner] acquire failed for ${sessionId}: ${errorMessage(error)}`,
                    );
                    return false;
                }
            }

            const owner = readOwner(lockPath);
            if (owner?.id === this.writer.id && owner.pid === this.writer.pid) {
                this.held = { sessionId, lockPath };
                return true;
            }
            if (owner && this.isPidAlive(owner.pid)) return false;
            if (!owner && !lockIsStale(lockPath, this.now())) return false;
            fs.rmSync(lockPath, { recursive: true, force: true });
            this.log?.(`[render-owner] recovered stale owner for ${sessionId}`);
        }
        return false;
    }

    owner(sessionId: string): RenderWriter | undefined {
        if (this.owns(sessionId)) return this.writer;
        const key = createHash("sha256").update(sessionId).digest("hex");
        const owner = readOwner(path.join(this.root, `${key}.lock`));
        return owner ? { id: owner.id, pid: owner.pid } : undefined;
    }

    alive(writer: RenderWriter | undefined): boolean {
        return !!writer && this.isPidAlive(writer.pid);
    }

    release(): void {
        const held = this.held;
        this.held = undefined;
        if (!held) return;
        const owner = readOwner(held.lockPath);
        if (owner?.id !== this.writer.id || owner.pid !== this.writer.pid) {
            this.log?.(`[render-owner] ownership changed before release for ${held.sessionId}`);
            return;
        }
        fs.rmSync(held.lockPath, { recursive: true, force: true });
    }
}

function readOwner(lockPath: string): OwnershipRecord | undefined {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
            id?: unknown;
            pid?: unknown;
            protocol?: unknown;
            startedAt?: unknown;
        };
        if (
            typeof value.id === "string" &&
            typeof value.pid === "number" &&
            typeof value.startedAt === "string"
        ) {
            return {
                id: value.id,
                pid: value.pid,
                protocol: typeof value.protocol === "number" ? value.protocol : 1,
                startedAt: value.startedAt,
            };
        }
    } catch {
        // The owner may still be between mkdir and its atomic-enough metadata write.
    }
    return undefined;
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
