import * as fs from "fs";
import { AgentAdapter, SessionInfo } from "../adapters/types";
import { createSessionRepository } from "./repositoryFactory";
import { SessionRepository, StoredSession } from "./repository";

export interface SessionIndexOptions {
    storageDir: string;
    adapters: readonly AgentAdapter[];
    log?: (message: string) => void;
    repository?: SessionRepository;
    disableSqlite?: boolean;
}

/** Stale-while-revalidate catalog backed by SQLite with portable fallbacks. */
export class SessionIndex {
    private readonly adapters: readonly AgentAdapter[];
    private readonly log: (message: string) => void;
    private readonly repository: SessionRepository;
    private sessions = new Map<string, StoredSession>();
    private reconcilePromise: Promise<SessionInfo[]> | undefined;
    private generation = 0;
    private disposed = false;

    constructor(options: SessionIndexOptions) {
        this.adapters = options.adapters;
        this.log = options.log ?? (() => undefined);
        this.repository = options.repository ?? createSessionRepository({
            storageDir: options.storageDir,
            log: this.log,
            disableSqlite: options.disableSqlite,
        });
        for (const stored of this.repository.list()) {
            this.sessions.set(keyOf(stored), stored);
        }
    }

    get repositoryKind(): SessionRepository["kind"] {
        return this.repository.kind;
    }

    listCached(): SessionInfo[] {
        return [...this.sessions.values()]
            .map(fromStored)
            .sort((left, right) => (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0));
    }

    get(backend: string, sessionId: string): SessionInfo | undefined {
        const stored = this.sessions.get(keyOf({ backend, sessionId }));
        return stored ? fromStored(stored) : undefined;
    }

    reconcile(): Promise<SessionInfo[]> {
        if (this.disposed) { return Promise.resolve(this.listCached()); }
        if (this.reconcilePromise) { return this.reconcilePromise; }
        const generation = ++this.generation;
        this.reconcilePromise = this.scan(generation)
            .finally(() => { this.reconcilePromise = undefined; });
        return this.reconcilePromise;
    }

    invalidate(): void {
        this.generation++;
    }

    /** Approximate memory used by the in-memory session catalog (bytes). */
    memoryUsageBytes(): number {
        let total = 0;
        for (const [key, session] of this.sessions) {
            // Rough estimate: key length + JSON-serialized session size
            total += key.length * 2;  // UTF-16 chars
            total += JSON.stringify(session).length * 2;
        }
        return total;
    }

    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.repository.dispose();
    }

    private async scan(generation: number): Promise<SessionInfo[]> {
        const startedAt = Date.now();
        const providerResults = await Promise.all(this.adapters.map(async (adapter) => {
            try {
                const cached = [...this.sessions.values()]
                    .filter((session) => session.backend === adapter.backend)
                    .map(fromStored);
                let listed: SessionInfo[];
                try {
                    listed = adapter.listSessionsIncremental
                        ? await adapter.listSessionsIncremental(cached)
                        : await adapter.listSessions();
                } catch {
                    listed = await adapter.listSessions().catch(() => []);
                }
                // Guard: if listSessions returned undefined/null, use empty array
                if (!Array.isArray(listed)) { listed = []; }
                return { backend: adapter.backend, listed: await Promise.all(listed.map(toStored)) };
            } catch (error) {
                this.log(`[sessions] ${adapter.backend} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        }));

        if (this.disposed || generation !== this.generation) { return this.listCached(); }
        for (const result of providerResults) {
            if (!result) { continue; }
            try {
                this.repository.replaceProvider(result.backend, result.listed);
                for (const [key, session] of this.sessions) {
                    if (session.backend === result.backend) { this.sessions.delete(key); }
                }
                for (const session of result.listed) { this.sessions.set(keyOf(session), session); }
            } catch (error) {
                this.log(`[sessions] ${result.backend} persistence failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.log(`[sessions] reconciled ${this.sessions.size} sessions in ${Date.now() - startedAt} ms (${this.repository.kind})`);
        return this.listCached();
    }
}

function keyOf(session: Pick<SessionInfo, "backend" | "sessionId">): string {
    return `${session.backend}\0${session.sessionId}`;
}

async function toStored(info: SessionInfo): Promise<StoredSession> {
    let sourceSize: number | undefined;
    let sourceMtimeMs: number | undefined;
    if (info.transcriptPath) {
        try {
            const stat = await fs.promises.stat(info.transcriptPath);
            sourceSize = stat.size;
            sourceMtimeMs = stat.mtimeMs;
        } catch { /* transient/missing transcripts remain indexable */ }
    }
    const { updatedAt, status: _status, deleting: _deleting, ...rest } = info;
    return {
        ...rest,
        updatedAt: updatedAt?.getTime(),
        sourceSize,
        sourceMtimeMs,
    };
}

function fromStored(stored: StoredSession): SessionInfo {
    const {
        updatedAt,
        sourceSize: _sourceSize,
        sourceMtimeMs: _sourceMtimeMs,
        ...rest
    } = stored;
    return { ...rest, updatedAt: updatedAt === undefined ? undefined : new Date(updatedAt) };
}