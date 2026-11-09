import * as fs from "fs";
import * as path from "path";
import type { SessionInfo } from "../adapters/types";

/** Minimal index surface the watcher needs (kept narrow for tests). */
export interface TranscriptWatcherTarget {
    listCached(): SessionInfo[];
}

export interface TranscriptWatcherOptions {
    debounceMs?: number;
    resyncIntervalMs?: number;
    maxDirectories?: number;
    log?: (message: string) => void;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RESYNC_MS = 10_000;
const DEFAULT_MAX_DIRECTORIES = 64;

/**
 * Issue #40 phase 7: watches ONLY the directories that hold indexed
 * transcripts — never a recursive watcher over the home directory — and
 * forwards debounced changes as invalidate({ path }) triggers. Directory
 * membership is re-synced from the index so new backends/sessions are picked
 * up without restarting anything; the periodic reconcile remains the
 * safety net for events a platform may drop.
 */
export class TranscriptWatcher {
    private readonly watchers = new Map<string, fs.FSWatcher>();
    private readonly pending = new Set<string>();
    private resyncTimer: ReturnType<typeof setInterval> | undefined;
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    constructor(
        private readonly target: TranscriptWatcherTarget,
        private readonly onTranscriptChange: (file: string) => void,
        private readonly options: TranscriptWatcherOptions = {},
    ) {}

    start(): void {
        if (this.resyncTimer) {
            return;
        }
        void this.sync();
        this.resyncTimer = setInterval(() => {
            void this.sync();
            if (this.pending.size > 0 && !this.flushTimer) {
                this.scheduleFlush();
            }
        }, this.options.resyncIntervalMs ?? DEFAULT_RESYNC_MS);
    }

    /** Directory currently watched? Exposed for tests/diagnostics only. */
    isWatching(directory: string): boolean {
        return this.watchers.has(directory);
    }

    async sync(): Promise<void> {
        const cap = this.options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
        const dirs = [
            ...new Set(
                this.target
                    .listCached()
                    .map((session) => session.transcriptPath)
                    .filter((file): file is string => !!file)
                    .map((file) => path.dirname(file)),
            ),
        ]
            .sort()
            .slice(0, cap);
        if (dirs.length === 0) {
            this.closeAll();
            return;
        }
        for (const dir of [...this.watchers.keys()]) {
            if (!dirs.includes(dir)) {
                this.watchers.get(dir)?.close();
                this.watchers.delete(dir);
            }
        }
        for (const dir of dirs) {
            if (this.watchers.has(dir)) {
                continue;
            }
            try {
                const watcher = fs.watch(
                    dir,
                    { persistent: false },
                    (_event, filename) => this.onWatchEvent(dir, filename),
                );
                watcher.on("error", () => this.dropDirectory(dir));
                this.watchers.set(dir, watcher);
            } catch (error) {
                (this.options.log ?? (() => undefined))(
                    `[watcher] cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.resyncTimer) {
            clearInterval(this.resyncTimer);
            this.resyncTimer = undefined;
        }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.pending.clear();
        this.closeAll();
    }

    private onWatchEvent(directory: string, filename: string | null): void {
        if (this.disposed) {
            return;
        }
        // A null filename means "something in this directory changed" (some
        // platforms): fall back to the directory so the coalesced rescan runs.
        this.pending.add(filename ? path.join(directory, filename) : directory);
        if (!this.flushTimer) {
            this.scheduleFlush();
        }
    }

    private scheduleFlush(): void {
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flush();
        }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    }

    private flush(): void {
        const files = [...this.pending];
        this.pending.clear();
        for (const file of files) {
            try {
                this.onTranscriptChange(file);
            } catch (error) {
                (this.options.log ?? (() => undefined))(
                    `[watcher] invalidation failed for ${file}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    private dropDirectory(directory: string): void {
        this.watchers.get(directory)?.close();
        this.watchers.delete(directory);
    }

    private closeAll(): void {
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
    }
}
