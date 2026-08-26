import * as fs from "fs";
import * as path from "path";
import { withFileLockSync } from "../fileLock";
import { InMemorySessionRepository } from "./memoryRepository";
import { sessionKey, StoredSession } from "./repository";

export const JSON_INDEX_FILE = "session-index.v1.json";
const SCHEMA_VERSION = 2;

interface StoredIndex {
    schemaVersion: number;
    generatedAt: number;
    sessions: StoredSession[];
}

export class JsonSessionRepository extends InMemorySessionRepository {
    override readonly kind = "json" as const;
    readonly file: string;

    constructor(storageDir: string) {
        super();
        this.file = path.join(storageDir, JSON_INDEX_FILE);
        this.load();
    }

    override replaceProvider(backend: string, sessions: readonly StoredSession[]): void {
        super.replaceProvider(backend, sessions);
        this.persist(new Set([backend]));
    }

    override replaceAll(sessions: readonly StoredSession[]): void {
        super.replaceAll(sessions);
        this.persist();
    }

    private load(): void {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredIndex;
            if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.sessions)) {
                return;
            }
            super.replaceAll(parsed.sessions.filter(validStoredSession));
        } catch {
            /* absent or corrupt snapshots rebuild safely */
        }
    }

    private persist(replacedProviders?: ReadonlySet<string>): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        withFileLockSync(this.file, () => {
            const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
            const local = this.list();
            const merged = replacedProviders
                ? mergeProviders(readStoredIndex(this.file), local, replacedProviders)
                : local;
            const snapshot: StoredIndex = {
                schemaVersion: SCHEMA_VERSION,
                generatedAt: Date.now(),
                sessions: merged,
            };
            try {
                fs.writeFileSync(temp, JSON.stringify(snapshot), "utf8");
                fs.renameSync(temp, this.file);
                // Keep this process aware of rows discovered by another
                // Extension Host; its next provider scan starts from the union.
                super.replaceAll(merged);
            } finally {
                try {
                    fs.unlinkSync(temp);
                } catch {
                    /* already renamed */
                }
            }
        });
    }
}

function readStoredIndex(file: string): StoredSession[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredIndex;
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
