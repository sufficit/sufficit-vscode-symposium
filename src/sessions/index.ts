import * as fs from "fs";
import { AgentAdapter, SessionInfo } from "../adapters/types";
import { createSessionRepository } from "./repositoryFactory";
import { SessionRepository, StoredSession } from "./repository";

export * from "./feature";

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
        this.repository =
            options.repository ??
            createSessionRepository({
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
            .sort(
                (left, right) =>
                    (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0),
            );
    }

    get(backend: string, sessionId: string): SessionInfo | undefined {
        const stored = this.sessions.get(keyOf({ backend, sessionId }));
        return stored ? fromStored(stored) : undefined;
    }

    reconcile(): Promise<SessionInfo[]> {
        if (this.disposed) {
            return Promise.resolve(this.listCached());
        }
        if (this.reconcilePromise) {
            return this.reconcilePromise;
        }
        const generation = ++this.generation;
        this.reconcilePromise = this.scan(generation).finally(() => {
            this.reconcilePromise = undefined;
        });
        return this.reconcilePromise;
    }

    invalidate(): void {
        this.generation++;
    }

    /**
     * Evicts a permanently deleted session immediately from memory and the
     * persistent index. Incrementing the generation also prevents a provider
     * scan that started before the physical scrub from restoring its stale row.
     */
    async forget(backend: string, sessionId: string): Promise<void> {
        this.generation++;
        this.sessions.delete(keyOf({ backend, sessionId }));
        const remaining = [...this.sessions.values()].filter(
            (session) => session.backend === backend,
        );
        try {
            // A deletion is user-initiated and rare: write it now instead of
            // waiting out the repository's debounce window.
            const pending = Promise.resolve(this.repository.replaceProvider(backend, remaining));
            void this.repository.flush?.();
            await pending;
        } catch (error) {
            this.log(
                `[sessions] failed to persist deletion for ${backend}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Approximate memory used by the in-memory session catalog (bytes). */
    memoryUsageBytes(): number {
        let total = 0;
        for (const [key, session] of this.sessions) {
            // Rough estimate: key length + JSON-serialized session size
            total += key.length * 2; // UTF-16 chars
            total += JSON.stringify(session).length * 2;
        }
        return total;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.generation++;
        try {
            await this.repository.dispose();
        } catch (error) {
            this.log(
                `[sessions] repository flush failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Hands rows to the repository and only logs a failed write; never blocks the caller. */
    private persistInBackground(backend: string, listed: readonly StoredSession[]): void {
        try {
            void Promise.resolve(this.repository.replaceProvider(backend, listed)).catch(
                (error: unknown) => this.logPersistFailure(backend, error),
            );
        } catch (error) {
            this.logPersistFailure(backend, error);
        }
    }

    private logPersistFailure(backend: string, error: unknown): void {
        this.log(
            `[sessions] ${backend} persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    private async scan(generation: number): Promise<SessionInfo[]> {
        const startedAt = Date.now();
        const providerResults = await Promise.all(
            this.adapters.map(async (adapter) => {
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
                    if (!Array.isArray(listed)) {
                        listed = [];
                    }
                    return {
                        backend: adapter.backend,
                        listed: await Promise.all(listed.map(toStored)),
                    };
                } catch (error) {
                    this.log(
                        `[sessions] ${adapter.backend} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    return undefined;
                }
            }),
        );

        if (this.disposed || generation !== this.generation) {
            return this.listCached();
        }
        // No await between the generation check above and the cache update, so a
        // concurrent forget()/invalidate() cannot interleave with this loop.
        // Durability is the repository's job and may be debounced: the catalog is
        // already correct in memory, so the scan must not wait for the disk.
        for (const result of providerResults) {
            if (!result) {
                continue;
            }
            this.persistInBackground(result.backend, result.listed);
            for (const [key, session] of this.sessions) {
                if (session.backend === result.backend) {
                    this.sessions.delete(key);
                }
            }
            for (const session of result.listed) {
                this.sessions.set(keyOf(session), session);
            }
        }
        this.log(
            `[sessions] reconciled ${this.sessions.size} sessions in ${Date.now() - startedAt} ms (${this.repository.kind})`,
        );
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
        } catch {
            /* transient/missing transcripts remain indexable */
        }
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
    const { updatedAt, sourceSize: _sourceSize, sourceMtimeMs: _sourceMtimeMs, ...rest } = stored;
    return { ...rest, updatedAt: updatedAt === undefined ? undefined : new Date(updatedAt) };
}
