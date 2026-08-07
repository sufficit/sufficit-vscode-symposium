import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AdapterQuotaSnapshot, AdapterUsageProvider, UsageQuotaWindow } from "./types";
import { parseAdapterQuota } from "./quota";

const MAX_FILES_PER_BACKEND = 24;
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_EVENTS_PER_BACKEND = 48;
const CACHE_TTL_MS = 15_000;

interface RecentFile {
    path: string;
    mtimeMs: number;
}

export type AdapterQuotaParser = (
    event: unknown,
    backend: string,
) => AdapterQuotaSnapshot | undefined;

function mergeSnapshots(
    current: AdapterQuotaSnapshot | undefined,
    incoming: AdapterQuotaSnapshot,
): AdapterQuotaSnapshot {
    const windows = new Map<string, UsageQuotaWindow>();
    // Input is scanned newest-first. Preserve the newest value for each
    // dynamically named window while older events fill missing windows.
    for (const window of current?.windows ?? []) {
        windows.set(window.id, window);
    }
    for (const window of incoming.windows) {
        if (!windows.has(window.id)) {
            windows.set(window.id, window);
        }
    }
    return {
        ...incoming,
        ...current,
        backend: incoming.backend,
        windows: [...windows.values()],
        updatedAt: Math.max(current?.updatedAt ?? 0, incoming.updatedAt),
    };
}

/** Parse quota events from a JSONL tail, newest event first. */
export function parseQuotaJsonl(
    text: string,
    backend: string,
    fallbackUpdatedAt: number,
    parser: AdapterQuotaParser = parseAdapterQuota,
): AdapterQuotaSnapshot[] {
    const snapshots: AdapterQuotaSnapshot[] = [];
    const lines = text.split(/\r?\n/);
    for (
        let index = lines.length - 1;
        index >= 0 && snapshots.length < MAX_EVENTS_PER_BACKEND;
        index--
    ) {
        const line = lines[index].trim();
        if (!line || (!line.includes("rate_limit") && !line.includes("rateLimit"))) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            const parsed = parser(event, backend);
            if (!parsed) {
                continue;
            }
            const payload =
                event.payload && typeof event.payload === "object"
                    ? (event.payload as Record<string, unknown>)
                    : undefined;
            const timestamp =
                event.timestamp ??
                event.created_at ??
                event.createdAt ??
                payload?.timestamp ??
                payload?.created_at ??
                payload?.createdAt;
            snapshots.push({
                ...parsed,
                updatedAt: timestamp != null ? parsed.updatedAt : fallbackUpdatedAt,
            });
        } catch {
            // A partially written final JSONL line is expected while a CLI is
            // running. Ignore it and continue with the preceding complete line.
        }
    }
    return snapshots;
}

async function collectRecentJsonl(root: string, found: RecentFile[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            await collectRecentJsonl(entryPath, found);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            try {
                const stat = await fs.stat(entryPath);
                found.push({ path: entryPath, mtimeMs: stat.mtimeMs });
            } catch {
                // A CLI may rotate a transcript between readdir and stat.
            }
        }
    }
}

async function readTail(file: RecentFile): Promise<string> {
    const handle = await fs.open(file.path, "r");
    try {
        const stat = await handle.stat();
        const length = Math.min(stat.size, MAX_TAIL_BYTES);
        const start = Math.max(0, stat.size - length);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        let text = buffer.toString("utf8");
        // When the tail begins mid-record, discard that incomplete first line.
        if (start > 0) {
            const newline = text.indexOf("\n");
            text = newline >= 0 ? text.slice(newline + 1) : "";
        }
        return text;
    } finally {
        await handle.close();
    }
}

async function loadBackend(
    backend: string,
    roots: string[],
    parser: AdapterQuotaParser,
): Promise<AdapterQuotaSnapshot | undefined> {
    const files: RecentFile[] = [];
    for (const root of roots) {
        await collectRecentJsonl(root, files);
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let merged: AdapterQuotaSnapshot | undefined;
    let eventCount = 0;
    for (const file of files.slice(0, MAX_FILES_PER_BACKEND)) {
        let snapshots: AdapterQuotaSnapshot[];
        try {
            snapshots = parseQuotaJsonl(await readTail(file), backend, file.mtimeMs, parser);
        } catch {
            continue;
        }
        for (const snapshot of snapshots) {
            merged = mergeSnapshots(merged, snapshot);
            eventCount++;
            if (eventCount >= MAX_EVENTS_PER_BACKEND) {
                return merged;
            }
        }
    }
    return merged;
}

/** Shared JSONL reader; each adapter module owns exactly one instance. */
export class JsonlAdapterUsage implements AdapterUsageProvider {
    private cached: { readAt: number; value: AdapterQuotaSnapshot } | undefined;

    constructor(
        readonly backend: string,
        readonly displayName: string,
        private readonly roots: () => string[],
        private readonly parser: AdapterQuotaParser = parseAdapterQuota,
    ) {}

    async read(force = false): Promise<AdapterQuotaSnapshot> {
        if (!force && this.cached && Date.now() - this.cached.readAt < CACHE_TTL_MS) {
            return this.cached.value;
        }
        const found = await loadBackend(this.backend, this.roots(), this.parser);
        const value: AdapterQuotaSnapshot = found
            ? { ...found, displayName: this.displayName, state: "ready" }
            : {
                  backend: this.backend,
                  displayName: this.displayName,
                  windows: [],
                  updatedAt: Date.now(),
                  state: "unavailable",
                  message: "This adapter has not reported usage limits yet.",
              };
        this.cached = { readAt: Date.now(), value };
        return value;
    }
}

/** Adapter singleton for providers that do not expose account quota JSON yet. */
export class EmptyAdapterUsage implements AdapterUsageProvider {
    constructor(
        readonly backend: string,
        readonly displayName: string,
        private readonly unavailableMessage = "This adapter does not expose usage limits yet.",
    ) {}

    read(): Promise<AdapterQuotaSnapshot> {
        return Promise.resolve({
            backend: this.backend,
            displayName: this.displayName,
            windows: [],
            updatedAt: Date.now(),
            state: "unavailable",
            message: this.unavailableMessage,
        });
    }
}
