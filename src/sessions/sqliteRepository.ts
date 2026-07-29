import * as fs from "fs";
import * as path from "path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { SessionRepository, StoredSession } from "./repository";

declare const __non_webpack_require__: NodeRequire;

export const SQLITE_INDEX_FILE = "symposium-sessions.sqlite";

const runtimeRequire: NodeRequire = typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : require;

interface SessionRow {
    backend: string;
    session_id: string;
    updated_at_ms: number | null;
    payload_json: string;
    source_size: number | null;
    source_mtime_ms: number | null;
}

export class NodeSqliteSessionRepository implements SessionRepository {
    readonly kind = "sqlite" as const;
    readonly file: string;
    private readonly db: DatabaseSyncType;
    private readonly legacyAlreadyImported: boolean;

    constructor(storageDir: string) {
        fs.mkdirSync(storageDir, { recursive: true });
        this.file = path.join(storageDir, SQLITE_INDEX_FILE);
        const sqlite = runtimeRequire("node:sqlite") as typeof import("node:sqlite");
        this.db = new sqlite.DatabaseSync(this.file);
        this.configure();
        this.migrate();
        this.legacyAlreadyImported = this.hasMigration(2);
    }

    list(): StoredSession[] {
        const rows = this.db.prepare(`
            SELECT backend, session_id, updated_at_ms, payload_json,
                   source_size, source_mtime_ms
            FROM sessions
            ORDER BY updated_at_ms DESC, session_id DESC
        `).all() as unknown as SessionRow[];
        const sessions: StoredSession[] = [];
        for (const row of rows) {
            try {
                const payload = JSON.parse(row.payload_json) as StoredSession;
                sessions.push({
                    ...payload,
                    backend: row.backend,
                    sessionId: row.session_id,
                    updatedAt: row.updated_at_ms ?? undefined,
                    sourceSize: row.source_size ?? undefined,
                    sourceMtimeMs: row.source_mtime_ms ?? undefined,
                });
            } catch { /* skip a malformed row without losing the catalog */ }
        }
        return sessions;
    }

    replaceProvider(backend: string, sessions: readonly StoredSession[]): void {
        this.transaction(() => {
            this.db.prepare("DELETE FROM sessions WHERE backend = ?").run(backend);
            this.insertMany(sessions);
        });
    }

    replaceAll(sessions: readonly StoredSession[]): void {
        this.transaction(() => {
            this.db.exec("DELETE FROM sessions");
            this.insertMany(sessions);
        });
    }

    importLegacy(sessions: readonly StoredSession[]): number {
        if (this.legacyAlreadyImported) { return 0; }
        this.transaction(() => {
            const insert = this.db.prepare(`
                INSERT OR IGNORE INTO sessions(
                    backend, session_id, updated_at_ms, payload_json,
                    source_size, source_mtime_ms
                ) VALUES (?, ?, ?, ?, ?, ?)
            `);
            for (const session of sessions) {
                insert.run(
                    session.backend,
                    session.sessionId,
                    session.updatedAt ?? null,
                    JSON.stringify(withoutFingerprint(session)),
                    session.sourceSize ?? null,
                    session.sourceMtimeMs ?? null,
                );
            }
            this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at_ms) VALUES (2, ?)")
                .run(Date.now());
        });
        return sessions.length;
    }

    dispose(): void {
        this.db.close();
    }

    private configure(): void {
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;
        `);
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at_ms INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS sessions (
                backend TEXT NOT NULL,
                session_id TEXT NOT NULL,
                updated_at_ms INTEGER,
                payload_json TEXT NOT NULL,
                source_size INTEGER,
                source_mtime_ms REAL,
                PRIMARY KEY (backend, session_id)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS sessions_recency_idx
                ON sessions(updated_at_ms DESC, session_id DESC);
            CREATE INDEX IF NOT EXISTS sessions_backend_recency_idx
                ON sessions(backend, updated_at_ms DESC, session_id DESC);
            INSERT OR IGNORE INTO schema_migrations(version, applied_at_ms)
                VALUES (1, unixepoch('subsec') * 1000);
        `);
    }

    private hasMigration(version: number): boolean {
        const row = this.db.prepare("SELECT 1 AS present FROM schema_migrations WHERE version = ?").get(version) as { present?: number } | undefined;
        return row?.present === 1;
    }

    private insertMany(sessions: readonly StoredSession[]): void {
        const insert = this.db.prepare(`
            INSERT INTO sessions(
                backend, session_id, updated_at_ms, payload_json,
                source_size, source_mtime_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(backend, session_id) DO UPDATE SET
                updated_at_ms = excluded.updated_at_ms,
                payload_json = excluded.payload_json,
                source_size = excluded.source_size,
                source_mtime_ms = excluded.source_mtime_ms
        `);
        for (const session of sessions) {
            insert.run(
                session.backend,
                session.sessionId,
                session.updatedAt ?? null,
                JSON.stringify(withoutFingerprint(session)),
                session.sourceSize ?? null,
                session.sourceMtimeMs ?? null,
            );
        }
    }

    private transaction(action: () => void): void {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            action();
            this.db.exec("COMMIT");
        } catch (error) {
            try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
            throw error;
        }
    }
}

function withoutFingerprint(session: StoredSession): StoredSession {
    const { sourceSize: _sourceSize, sourceMtimeMs: _sourceMtimeMs, ...payload } = session;
    return payload;
}
