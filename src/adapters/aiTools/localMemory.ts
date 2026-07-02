/**
 * Local memory implementation that works with any backend.
 *
 * This provides a file-based fallback for memory operations when the HubClient
 * is unavailable or returns 401 (unauthorized). It ensures that tools like
 * memory_search, memory_save, and add_guardrail work universally across all
 * backends (openai, claude, sufficit-ai, etc.).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface CompactRecord {
    id: string;
    type: string;
    title: string;
    summary: string;
    tags?: string;
}

export interface Observation {
    id?: string;
    type: string;
    title: string;
    summary: string;
    payload?: string;
    tags?: string;
    expiresAtUtc?: string;
}

/** Memory directory location */
const MEMORY_DIR = path.join(os.homedir(), ".symposium", "local-memory");

/** Ensure memory directory exists */
function ensureMemoryDir(): void {
    if (!fs.existsSync(MEMORY_DIR)) {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
}

/** Generate a unique ID */
function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/** Get path for an observation file */
function getObservationPath(id: string): string {
    return path.join(MEMORY_DIR, `${id}.json`);
}

/** Read all observations from disk */
function loadAllObservations(): Observation[] {
    ensureMemoryDir();
    const observations: Observation[] = [];

    try {
        const files = fs.readdirSync(MEMORY_DIR);
        for (const file of files) {
            if (!file.endsWith(".json")) continue;

            const filePath = path.join(MEMORY_DIR, file);
            try {
                const content = fs.readFileSync(filePath, "utf-8");
                const obs = JSON.parse(content) as Observation;
                observations.push(obs);
            } catch (e) {
                // Skip corrupted files
                continue;
            }
        }
    } catch (e) {
        // Return empty if read fails
    }

    return observations;
}

/** Convert observation to compact record */
function toCompactRecord(obs: Observation): CompactRecord {
    return {
        id: obs.id || "",
        type: obs.type,
        title: obs.title,
        summary: obs.summary,
        tags: obs.tags,
    };
}

/** Local memory implementation */
export class LocalMemory {
    /** Search memory by query */
    async searchMemory(options: {
        query: string;
        type?: string;
        limit?: number;
    }): Promise<CompactRecord[]> {
        const allObs = loadAllObservations();
        const queryLower = options.query.toLowerCase();

        // Filter by type if specified
        let filtered = allObs;
        if (options.type) {
            filtered = filtered.filter((obs) => obs.type === options.type);
        }

        // Filter by query (search in title and summary)
        const matching = filtered.filter((obs) => {
            const titleLower = obs.title.toLowerCase();
            const summaryLower = obs.summary.toLowerCase();
            return titleLower.includes(queryLower) || summaryLower.includes(queryLower);
        });

        // Apply limit
        const limit = options.limit || 20;
        const results = matching.slice(0, limit);

        return results.map(toCompactRecord);
    }

    /** Get observations by IDs */
    async getByIds(ids: string[]): Promise<Observation[]> {
        ensureMemoryDir();
        const results: Observation[] = [];

        for (const id of ids) {
            const filePath = getObservationPath(id);
            try {
                const content = fs.readFileSync(filePath, "utf-8");
                const obs = JSON.parse(content) as Observation;
                results.push(obs);
            } catch (e) {
                // Skip missing or corrupted files
                continue;
            }
        }

        return results;
    }

    /** Save an observation */
    async save(obs: Observation): Promise<{ id: string }> {
        ensureMemoryDir();

        // Generate ID if not provided
        const id = obs.id || generateId();
        const obsWithId = { ...obs, id };

        // Write to disk
        const filePath = getObservationPath(id);
        fs.writeFileSync(filePath, JSON.stringify(obsWithId, null, 2));

        return { id };
    }

    /** Check if local memory is available */
    static async isAvailable(): Promise<boolean> {
        try {
            ensureMemoryDir();
            const testPath = path.join(MEMORY_DIR, ".available");
            fs.writeFileSync(testPath, "test");
            fs.unlinkSync(testPath);
            return true;
        } catch (e) {
            return false;
        }
    }
}