import * as fs from "fs";

interface Snapshot {
    /** File content before the session's first edit, or null if it didn't exist. */
    original: string | null;
}

/**
 * Per-session, per-file "before" snapshots so a change can be reverted ("go
 * back in time") regardless of git. The first time a session edits a file we
 * capture its prior content (synchronously, before the CLI applies the edit);
 * reject restores it, approve drops it.
 *
 * Keyed by session id (Hugo's GUID model) so sessions never cross-contaminate.
 */
class SnapshotStore {
    private readonly bySession = new Map<string, Map<string, Snapshot>>();

    private bucket(sessionId: string): Map<string, Snapshot> {
        let m = this.bySession.get(sessionId);
        if (!m) {
            m = new Map();
            this.bySession.set(sessionId, m);
        }
        return m;
    }

    /** Records the file's current content as the baseline, once per session+file. */
    capture(sessionId: string, filePath: string): void {
        if (!sessionId || !filePath) {
            return;
        }
        const bucket = this.bucket(sessionId);
        if (bucket.has(filePath)) {
            return;
        } // keep the earliest baseline
        let original: string | null = null;
        try {
            original = fs.readFileSync(filePath, "utf8");
        } catch {
            original = null;
        }
        bucket.set(filePath, { original });
    }

    has(sessionId: string, filePath: string): boolean {
        return !!this.bySession.get(sessionId)?.has(filePath);
    }

    /** Baseline content for a file (undefined if not snapshotted). */
    baseline(sessionId: string, filePath: string): string | null | undefined {
        const snap = this.bySession.get(sessionId)?.get(filePath);
        return snap ? snap.original : undefined;
    }

    /** Reverts the file to its baseline (or deletes it if it was newly created). */
    async revert(sessionId: string, filePath: string): Promise<boolean> {
        const snap = this.bySession.get(sessionId)?.get(filePath);
        if (!snap) {
            return false;
        }
        try {
            if (snap.original === null) {
                await fs.promises.rm(filePath, { force: true });
            } else {
                await fs.promises.writeFile(filePath, snap.original, "utf8");
            }
            this.bySession.get(sessionId)?.delete(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /** Accepts the current content: drops the baseline. */
    accept(sessionId: string, filePath: string): void {
        this.bySession.get(sessionId)?.delete(filePath);
    }

    /** Forgets a whole session's snapshots (on delete). */
    clearSession(sessionId: string): void {
        this.bySession.delete(sessionId);
    }
}

export const snapshots = new SnapshotStore();
