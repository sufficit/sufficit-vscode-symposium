import * as fs from "fs";
import { AgentAdapter, SessionInfo } from "../adapters/types";
import { jsonlMetadataCacheStats, jsonlReadStats } from "../adapters/jsonlPrefix";
import { createSessionRepository } from "./repositoryFactory";
import { SessionRepository, StoredSession } from "./repository";
import {
    applyProviderResult,
    InvalidateChange,
    providerSignature,
    resolveColdWaiters,
    resolveInvalidateBackends,
} from "./indexSupport";

export * from "./feature";

export interface SessionIndexOptions {
    storageDir: string;
    adapters: readonly AgentAdapter[];
    log?: (message: string) => void;
    repository?: SessionRepository;
    disableSqlite?: boolean;
    /** Fires when an applied scan changes the effective catalog (issue #40). */
    onChange?: () => void;
}

/** Stale-while-revalidate catalog backed by SQLite with portable fallbacks. */
export class SessionIndex {
    private readonly adapters: readonly AgentAdapter[];
    private readonly log: (message: string) => void;
    private readonly repository: SessionRepository;
    private sessions = new Map<string, StoredSession>();
    private reconcilePromise: Promise<SessionInfo[]> | undefined;
    private reconcileJoins = 0;
    private generation = 0;
    private disposed = false;
    private readonly onChange?: () => void;
    private readonly coldWaiters: { resolve(sessions: SessionInfo[]): void }[] = [];
    private pendingTargeted = new Set<string>();
    private targetedScan: Promise<void> | undefined;

    constructor(options: SessionIndexOptions) {
        this.adapters = options.adapters;
        this.onChange = options.onChange;
        this.log = options.log ?? (() => undefined);
        this.repository =
            options.repository ??
            createSessionRepository({
                storageDir: options.storageDir,
                log: this.log,
                disableSqlite: options.disableSqlite,
            });
        const loadedAt = Date.now();
        for (const stored of this.repository.list()) {
            this.sessions.set(keyOf(stored), stored);
        }
        this.log(
            `[sessions] index snapshot loaded ${this.sessions.size} sessions in ${Date.now() - loadedAt} ms (${this.repository.kind})`,
        );
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

    /**
     * Cold start (issue #40): resolves with the first useful snapshot — as
     * soon as one backend's rows land — instead of waiting for every backend.
     * Fresh installs fall back to the end-of-scan snapshot; never hangs.
     */
    ready(): Promise<SessionInfo[]> {
        if (this.sessions.size > 0 || this.disposed) {
            return Promise.resolve(this.listCached());
        }
        return new Promise<SessionInfo[]>((resolve) => {
            this.coldWaiters.push(resolve);
        });
    }

    reconcile(): Promise<SessionInfo[]> {
        if (this.disposed) {
            return Promise.resolve(this.listCached());
        }
        if (this.reconcilePromise) {
            this.reconcileJoins++;
            this.log(
                `[sessions] reconcile joined an in-flight scan (joined callers: ${this.reconcileJoins})`,
            );
            return this.reconcilePromise;
        }
        const generation = ++this.generation;
        this.reconcilePromise = this.scan(generation).finally(() => {
            this.reconcilePromise = undefined;
        });
        return this.reconcilePromise;
    }

    /**
     * Marks cached knowledge stale (issue #40 phase 7). With a change, only
     * the affected backends are queued for a coalesced targeted rescan; a
     * changeless call (manual refresh) queues every backend the same way.
     */
    invalidate(change?: InvalidateChange): void {
        this.generation++;
        if (this.disposed) {
            return;
        }
        const backends = change
            ? resolveInvalidateBackends(change, this.adapters, this.sessions)
            : this.adapters.map((adapter) => adapter.backend);
        for (const backend of backends) {
            this.pendingTargeted.add(backend);
        }
        if (this.pendingTargeted.size > 0) {
            void this.drainTargeted();
        }
    }

    /**
     * Runs one coalesced targeted rescan at a time. A targeted scan never
     * races a full reconcile: it waits for the shared scan to settle so the
     * catalog only ever advances one generation at a time.
     */
    private async drainTargeted(): Promise<void> {
        if (this.targetedScan) {
            return;
        }
        const drain = (async () => {
            while (this.pendingTargeted.size > 0 && !this.disposed) {
                if (this.reconcilePromise) {
                    try {
                        await this.reconcilePromise;
                    } catch {
                        /* provider failures are already logged by the scan */
                    }
                    continue;
                }
                const only = new Set(this.pendingTargeted);
                this.pendingTargeted.clear();
                const generation = ++this.generation;
                await this.scan(generation, only);
            }
        })();
        this.targetedScan = drain.finally(() => {
            this.targetedScan = undefined;
        });
        await this.targetedScan;
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

    private async scan(
        generation: number,
        only?: ReadonlySet<string>,
    ): Promise<SessionInfo[]> {
        const startedAt = Date.now();
        // Issue #40: each provider's rows are applied the moment its own scan
        // finishes, so the catalog (and any cold-start waiter) sees the first
        // useful partial list without waiting for the slowest backend.
        await Promise.all(
            this.adapters.map(async (adapter) => {
                if (only && !only.has(adapter.backend)) {
                    return;
                }
                const backendStartedAt = Date.now();
                let listed: StoredSession[] | undefined;
                try {
                    const cached = [...this.sessions.values()]
                        .filter((session) => session.backend === adapter.backend)
                        .map(fromStored);
                    let sessions: SessionInfo[];
                    try {
                        sessions = adapter.listSessionsIncremental
                            ? await adapter.listSessionsIncremental(cached)
                            : await adapter.listSessions();
                    } catch {
                        sessions = await adapter.listSessions().catch(() => []);
                    }
                    // Guard: if listSessions returned undefined/null, use empty array
                    if (!Array.isArray(sessions)) {
                        sessions = [];
                    }
                    listed = await Promise.all(sessions.map(toStored));
                } catch (error) {
                    this.log(
                        `[sessions] ${adapter.backend} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    return;
                }
                // No await between the generation check and the cache update,
                // so a concurrent forget()/invalidate() cannot interleave.
                // Durability is the repository's job and may be debounced: the
                // catalog is already correct in memory, so the scan must not
                // wait for the disk.
                if (this.disposed || generation !== this.generation || !listed) {
                    return;
                }
                const before = providerSignature(this.sessions, adapter.backend);
                this.applyProvider(adapter.backend, listed);
                const unchanged =
                    providerSignature(this.sessions, adapter.backend) === before;
                this.log(
                    `[sessions] ${adapter.backend} discovery ${Date.now() - backendStartedAt} ms, ${listed.length} sessions${unchanged ? " (unchanged)" : ""}`,
                );
                if (!unchanged) {
                    this.onChange?.();
                }
                this.releaseColdWaiters();
            }),
        );
        if (!only) {
            const reads = jsonlReadStats();
            const cache = jsonlMetadataCacheStats();
            this.log(
                `[sessions] reconciled ${this.sessions.size} sessions in ${Date.now() - startedAt} ms (${this.repository.kind}; reads=${reads.reads} bytes=${reads.bytesRead} cache hits=${cache.hits} misses=${cache.misses} joined=${cache.joined})`,
            );
        }
        this.releaseColdWaiters();
        return this.listCached();
    }

    /** Applies one provider's rows to the catalog and persists in background. */
    private applyProvider(backend: string, listed: readonly StoredSession[]): void {
        applyProviderResult(this.sessions, backend, listed);
        this.persistInBackground(backend, listed);
    }

    private releaseColdWaiters(): void {
        if (this.coldWaiters.length) {
            resolveColdWaiters(this.coldWaiters, () => this.listCached());
        }
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
