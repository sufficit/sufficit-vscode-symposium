import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../fileLock";
import { InMemorySessionRepository } from "./memoryRepository";
import { sessionKey, StoredSession } from "./repository";

export const JSON_INDEX_FILE = "session-index.v1.json";
const SCHEMA_VERSION = 2;
/**
 * Quiet period before queued index changes reach the disk. Slow journaled
 * filesystems can take hundreds of ms per metadata operation, so bursts
 * (one reconcile touches every provider) must collapse into a single write.
 */
export const DEFAULT_PERSIST_DEBOUNCE_MS = 1_000;

export interface JsonSessionRepositoryOptions {
    /** Quiet period before a write; `0` writes on the next timer tick. */
    debounceMs?: number;
}

interface StoredIndex {
    schemaVersion: number;
    generatedAt: number;
    sessions: StoredSession[];
}

interface PersistWaiter {
    resolve: () => void;
    reject: (error: unknown) => void;
}

export class JsonSessionRepository extends InMemorySessionRepository {
    override readonly kind = "json" as const;
    readonly file: string;
    private pendingAll = false;
    private pendingProviders = new Set<string>();
    private inflightProviders = new Set<string>();
    private waiters: PersistWaiter[] = [];
    private drain: Promise<void> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly debounceMs: number;

    constructor(storageDir: string, options: JsonSessionRepositoryOptions = {}) {
        super();
        this.file = path.join(storageDir, JSON_INDEX_FILE);
        this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS);
        // Read once at activation: constructors cannot await and the
        // catalog must be primed before the first listCached() call.
        this.load();
    }

    override replaceProvider(backend: string, sessions: readonly StoredSession[]): Promise<void> {
        const unchanged = this.sameAsStored(backend, sessions);
        void super.replaceProvider(backend, sessions);
        // A periodic reconcile usually finds nothing new: rewriting an
        // identical snapshot only burns journal commits. Pending/in-flight
        // work for this provider still has to settle, so it is not skipped.
        if (unchanged && !this.hasWorkFor(backend)) return Promise.resolve();
        this.pendingProviders.add(backend);
        return this.enqueue();
    }

    override replaceAll(sessions: readonly StoredSession[]): Promise<void> {
        void super.replaceAll(sessions);
        this.pendingAll = true;
        return this.enqueue();
    }

    /** Resolves after every queued write has reached storage, skipping the debounce window. */
    async flush(): Promise<void> {
        await this.drainNow();
        // One bounded retry of work a failed write left behind; never spin on a persistent error.
        if (this.hasPending() || this.waiters.length) await this.drainNow();
    }

    override async dispose(): Promise<void> {
        await this.flush();
    }

    private hasPending(): boolean {
        return this.pendingAll || this.pendingProviders.size > 0;
    }

    private hasWorkFor(backend: string): boolean {
        return (
            this.pendingAll ||
            this.pendingProviders.has(backend) ||
            this.inflightProviders.has(backend)
        );
    }

    private sameAsStored(backend: string, sessions: readonly StoredSession[]): boolean {
        const current = [...this.sessions.values()].filter((item) => item.backend === backend);
        return fingerprint(current) === fingerprint(sessions);
    }

    private load(): void {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredIndex;
            if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.sessions)) {
                return;
            }
            this.sessions = new Map(
                parsed.sessions.filter(validStoredSession).map((item) => [sessionKey(item), item]),
            );
        } catch {
            /* absent or corrupt snapshots rebuild safely */
        }
    }

    /** Coalesces bursts: all waiters of one batch share a single locked write. */
    private enqueue(): Promise<void> {
        const promise = new Promise<void>((resolve, reject) => {
            this.waiters.push({ resolve, reject });
        });
        this.startDrain();
        return promise;
    }

    /** Arms the debounce timer; every change inside the window shares the same write. */
    private startDrain(): void {
        if (this.drain || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.runDrain();
        }, this.debounceMs);
    }

    private runDrain(): void {
        if (this.drain) return;
        this.drain = this.drainQueue().finally(() => {
            this.drain = undefined;
            // Changes that arrived during the write wait out a fresh debounce window.
            if (this.waiters.length) this.startDrain();
        });
    }

    /** Writes queued work right now (no debounce) and resolves when the write settles. */
    private drainNow(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (!this.drain && (this.waiters.length || this.hasPending())) this.runDrain();
        return (this.drain ?? Promise.resolve()).catch(() => undefined);
    }

    private async drainQueue(): Promise<void> {
        if (!this.waiters.length && !this.hasPending()) return;
        const waiters = this.waiters.splice(0);
        const all = this.pendingAll;
        const providers = new Set(this.pendingProviders);
        this.pendingAll = false;
        this.pendingProviders.clear();
        this.inflightProviders = providers;
        try {
            await this.persist(all ? undefined : providers);
            for (const waiter of waiters) waiter.resolve();
        } catch (error) {
            // Keep the unwritten work so the next write or flush retries it.
            if (all) this.pendingAll = true;
            for (const provider of providers) this.pendingProviders.add(provider);
            for (const waiter of waiters) waiter.reject(error);
        } finally {
            this.inflightProviders = new Set();
        }
    }

    private async persist(replacedProviders?: ReadonlySet<string>): Promise<void> {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await withFileLock(this.file, async () => {
            const temp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
            const local = this.list();
            const merged = replacedProviders
                ? mergeProviders(await readStoredIndex(this.file), local, replacedProviders)
                : local;
            const snapshot: StoredIndex = {
                schemaVersion: SCHEMA_VERSION,
                generatedAt: Date.now(),
                sessions: merged,
            };
            try {
                await fsp.writeFile(temp, JSON.stringify(snapshot), "utf8");
                await fsp.rename(temp, this.file);
                if (replacedProviders) this.adoptForeignRows(merged, replacedProviders);
            } finally {
                await fsp.rm(temp, { force: true }).catch(() => undefined);
            }
        });
    }

    /**
     * Keeps this process aware of rows discovered by another Extension Host
     * without discarding provider updates queued while the write was running.
     */
    private adoptForeignRows(
        merged: readonly StoredSession[],
        replacedProviders: ReadonlySet<string>,
    ): void {
        const owned = (backend: string) =>
            replacedProviders.has(backend) ||
            this.pendingProviders.has(backend) ||
            this.inflightProviders.has(backend);
        if (this.pendingAll) return;
        for (const [key, session] of this.sessions) {
            if (!owned(session.backend)) this.sessions.delete(key);
        }
        for (const session of merged) {
            if (!owned(session.backend)) this.sessions.set(sessionKey(session), session);
        }
    }
}

/** Order-insensitive identity of a provider's rows, used to detect no-op replacements. */
function fingerprint(sessions: readonly StoredSession[]): string {
    return JSON.stringify(sessions.map((session) => stableStringify(session)).sort());
}

function stableStringify(value: unknown): string {
    return JSON.stringify(value, (_key, nested) =>
        nested && typeof nested === "object" && !Array.isArray(nested)
            ? Object.fromEntries(
                  Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
                      a < b ? -1 : a > b ? 1 : 0,
                  ),
              )
            : nested,
    );
}

async function readStoredIndex(file: string): Promise<StoredSession[]> {
    try {
        const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as StoredIndex;
        return parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.sessions)
            ? parsed.sessions.filter(validStoredSession)
            : [];
    } catch {
        return [];
    }
}

function mergeProviders(
    persisted: readonly StoredSession[],
    local: readonly StoredSession[],
    replacedProviders: ReadonlySet<string>,
): StoredSession[] {
    const merged = new Map<string, StoredSession>();
    for (const session of persisted) {
        if (!replacedProviders.has(session.backend)) merged.set(sessionKey(session), session);
    }
    for (const session of local) {
        if (replacedProviders.has(session.backend)) merged.set(sessionKey(session), session);
    }
    return [...merged.values()];
}

function validStoredSession(value: unknown): value is StoredSession {
    if (!value || typeof value !== "object") {
        return false;
    }
    const item = value as Partial<StoredSession>;
    return (
        typeof item.backend === "string" &&
        typeof item.sessionId === "string" &&
        typeof item.title === "string"
    );
}
