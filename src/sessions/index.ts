import * as fs from "fs";
import * as path from "path";
import { AgentAdapter, SessionInfo } from "../adapters/types";

const SCHEMA_VERSION = 1;
const STORE_FILE = "session-index.v1.json";

interface StoredSession extends Omit<SessionInfo, "updatedAt" | "status" | "deleting"> {
    updatedAt?: number;
    sourceSize?: number;
    sourceMtimeMs?: number;
}

interface StoredIndex {
    schemaVersion: number;
    generatedAt: number;
    sessions: StoredSession[];
}

export interface SessionIndexOptions {
    storageDir: string;
    adapters: readonly AgentAdapter[];
    /** Optional logger; intentionally avoids a VS Code dependency for tests/code-server. */
    log?: (message: string) => void;
}

/**
 * Portable persistent metadata index for file-backed agent sessions.
 *
 * The persisted file is a compact snapshot under ExtensionContext.globalStorageUri.
 * Reads are synchronous only for the small snapshot during activation. Provider
 * reconciliation is asynchronous, single-flight, and writes by temp+rename.
 * This avoids native SQLite ABI dependencies in desktop, Remote WSL/SSH,
 * containers, and code-server while retaining stale-while-revalidate startup.
 */
export class SessionIndex {
    private readonly file: string;
    private readonly adapters: readonly AgentAdapter[];
    private readonly log: (message: string) => void;
    private sessions = new Map<string, StoredSession>();
    private reconcilePromise: Promise<SessionInfo[]> | undefined;
    private generation = 0;
    private disposed = false;

    constructor(options: SessionIndexOptions) {
        this.file = path.join(options.storageDir, STORE_FILE);
        this.adapters = options.adapters;
        this.log = options.log ?? (() => undefined);
        this.loadSnapshot();
    }

    /** Returns the cached snapshot immediately, newest first. */
    listCached(): SessionInfo[] {
        return [...this.sessions.values()]
            .map(fromStored)
            .sort(compareNewest);
    }

    /** Direct indexed lookup without scanning any provider directory. */
    get(backend: string, sessionId: string): SessionInfo | undefined {
        const item = this.sessions.get(keyOf(backend, sessionId));
        return item ? fromStored(item) : undefined;
    }

    /**
     * Reconciles every provider once. Concurrent callers share the same work.
     * The previous snapshot remains available while providers scan in background.
     */
    reconcile(): Promise<SessionInfo[]> {
        if (this.reconcilePromise) { return this.reconcilePromise; }
        const generation = ++this.generation;
        this.reconcilePromise = this.reconcileImpl(generation)
            .finally(() => { this.reconcilePromise = undefined; });
        return this.reconcilePromise;
    }

    /** Invalidates pending results. A later reconcile starts from current providers. */
    invalidate(): void {
        this.generation++;
    }

    dispose(): void {
        this.disposed = true;
        this.generation++;
    }

    private async reconcileImpl(generation: number): Promise<SessionInfo[]> {
        const started = Date.now();
        const results = await Promise.all(this.adapters.map(async (adapter) => {
            try {
                const cached = this.listCached().filter((item) => item.backend === adapter.backend);
                const sessions = adapter.listSessionsIncremental
                    ? await adapter.listSessionsIncremental(cached)
                    : await adapter.listSessions();
                return { backend: adapter.backend, ok: true as const, sessions };
            } catch (error) {
                this.log(`[session-index] ${adapter.backend} reconciliation failed: ${String(error)}`);
                return { backend: adapter.backend, ok: false as const, sessions: [] as SessionInfo[] };
            }
        }));
        if (this.disposed || generation !== this.generation) {
            return this.listCached();
        }

        const next = new Map(this.sessions);
        for (const result of results) {
            // Fail closed per provider: keep its last known-good snapshot if the
            // provider fails, but replace it completely after a successful scan
            // so deleted transcripts disappear from the index.
            if (!result.ok) { continue; }
            for (const key of [...next.keys()]) {
                if (key.startsWith(`${result.backend}\0`)) { next.delete(key); }
            }
            for (const info of result.sessions) {
                const stored = await toStored(info);
                next.set(keyOf(info.backend, info.sessionId), stored);
            }
        }
        this.sessions = next;
        await this.persist(generation);
        this.log(`[session-index] reconciled ${next.size} sessions in ${Date.now() - started}ms`);
        return this.listCached();
    }

    private loadSnapshot(): void {
        let parsed: StoredIndex;
        try {
            parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredIndex;
        } catch {
            return;
        }
        if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.sessions)) {
            this.log(`[session-index] ignored incompatible snapshot at ${this.file}`);
            return;
        }
        for (const item of parsed.sessions) {
            if (!item || typeof item.backend !== "string" || typeof item.sessionId !== "string" || typeof item.title !== "string") {
                continue;
            }
            this.sessions.set(keyOf(item.backend, item.sessionId), item);
        }
        this.log(`[session-index] loaded ${this.sessions.size} cached sessions`);
    }

    private async persist(generation: number): Promise<void> {
        if (this.disposed || generation !== this.generation) { return; }
        const payload: StoredIndex = {
            schemaVersion: SCHEMA_VERSION,
            generatedAt: Date.now(),
            sessions: [...this.sessions.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
        };
        const dir = path.dirname(this.file);
        const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(temp, JSON.stringify(payload), "utf8");
            await fs.promises.rename(temp, this.file);
        } catch (error) {
            await fs.promises.unlink(temp).catch(() => undefined);
            this.log(`[session-index] persist failed: ${String(error)}`);
        }
    }
}

function keyOf(backend: string, sessionId: string): string {
    return `${backend}\0${sessionId}`;
}

function compareNewest(a: SessionInfo, b: SessionInfo): number {
    return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
}

async function toStored(info: SessionInfo): Promise<StoredSession> {
    const { updatedAt, status: _status, deleting: _deleting, ...rest } = info;
    let sourceSize: number | undefined;
    let sourceMtimeMs: number | undefined;
    if (info.transcriptPath) {
        try {
            const stat = await fs.promises.stat(info.transcriptPath);
            sourceSize = stat.size;
            sourceMtimeMs = stat.mtimeMs;
        } catch {
            // The provider result remains useful even if the source disappears
            // between discovery and snapshot persistence.
        }
    }
    return {
        ...rest,
        updatedAt: updatedAt?.getTime(),
        sourceSize,
        sourceMtimeMs,
    };
}

function fromStored(stored: StoredSession): SessionInfo {
    const { updatedAt, sourceSize: _sourceSize, sourceMtimeMs: _sourceMtimeMs, ...rest } = stored;
    return {
        ...rest,
        updatedAt: typeof updatedAt === "number" ? new Date(updatedAt) : undefined,
    };
}
