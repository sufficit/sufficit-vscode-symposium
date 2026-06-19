/**
 * File-based model cache shared across all adapters.
 * Stored at ~/.symposium/model-cache.json — each key is a backend/url slug.
 * Only successful fetches update `lastUpdate` so stale fallbacks are clear.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CACHE_FILE = path.join(os.homedir(), ".symposium", "model-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export interface ModelCacheEntry {
    models: string[];
    labels?: Record<string, string>;
    lastUpdate: string; // ISO 8601
}

type CacheStore = Record<string, ModelCacheEntry>;

function readStore(): CacheStore {
    try {
        const raw = fs.readFileSync(CACHE_FILE, "utf8");
        return JSON.parse(raw) as CacheStore;
    } catch {
        return {};
    }
}

function writeStore(store: CacheStore): void {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2), "utf8");
    } catch {
        // non-fatal: operate without persistence
    }
}

export function getCached(key: string): ModelCacheEntry | undefined {
    return readStore()[key];
}

export function setCached(key: string, entry: ModelCacheEntry): void {
    const store = readStore();
    store[key] = entry;
    writeStore(store);
}

export function isFresh(entry: ModelCacheEntry): boolean {
    const age = Date.now() - new Date(entry.lastUpdate).getTime();
    return age < CACHE_TTL_MS;
}
