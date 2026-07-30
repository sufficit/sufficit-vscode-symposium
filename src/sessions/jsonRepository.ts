import * as fs from "fs";
import * as path from "path";
import { InMemorySessionRepository } from "./memoryRepository";
import { StoredSession } from "./repository";

export const JSON_INDEX_FILE = "session-index.v1.json";
const SCHEMA_VERSION = 1;

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
        this.persist();
    }

    override replaceAll(sessions: readonly StoredSession[]): void {
        super.replaceAll(sessions);
        this.persist();
    }

    private load(): void {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredIndex;
            if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.sessions)) { return; }
            super.replaceAll(parsed.sessions.filter(validStoredSession));
        } catch { /* absent or corrupt snapshots rebuild safely */ }
    }

    private persist(): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        const snapshot: StoredIndex = {
            schemaVersion: SCHEMA_VERSION,
            generatedAt: Date.now(),
            sessions: this.list(),
        };
        try {
            fs.writeFileSync(temp, JSON.stringify(snapshot), "utf8");
            fs.renameSync(temp, this.file);
        } finally {
            try { fs.unlinkSync(temp); } catch { /* already renamed */ }
        }
    }
}

function validStoredSession(value: unknown): value is StoredSession {
    if (!value || typeof value !== "object") { return false; }
    const item = value as Partial<StoredSession>;
    return typeof item.backend === "string"
        && typeof item.sessionId === "string"
        && typeof item.title === "string";
}
