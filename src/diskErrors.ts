import * as fs from "node:fs";

/**
 * Storage exhaustion detection for local coordination files (tmpdir leases,
 * render-owner locks). Node/libuv has no name for some Linux errnos: a full
 * tmpfs or exceeded quota surfaces as "Unknown system error -122" (EDQUOT),
 * which told the user nothing. These helpers turn it into an actionable
 * message naming the directory and its free space.
 */
const STORAGE_CODES = new Set(["ENOSPC", "EDQUOT"]);
/** Linux errnos: ENOSPC=28, EDQUOT=122. */
const STORAGE_ERRNOS = new Set([-28, -122, 28, 122]);

export function isStorageFullError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const { code, errno, message } = error as {
        code?: unknown;
        errno?: unknown;
        message?: unknown;
    };
    if (typeof code === "string" && STORAGE_CODES.has(code)) return true;
    if (typeof errno === "number" && STORAGE_ERRNOS.has(errno)) return true;
    if (typeof code === "string" && /^Unknown system error -(28|122)$/.test(code)) return true;
    return (
        typeof message === "string" &&
        /\b(ENOSPC|EDQUOT|Unknown system error -(28|122))\b/.test(message)
    );
}

/** Free/total bytes of the filesystem holding `dir`; undefined when unreadable. */
export function readFreeSpace(dir: string): { free: number; total: number } | undefined {
    try {
        const stats = fs.statfsSync(dir);
        return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    } catch {
        return undefined;
    }
}

function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Actionable text for a storage-full failure while writing under `dir`. */
export function describeStorageFull(dir: string, error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const space = readFreeSpace(dir);
    const spaceText = space
        ? ` (${formatBytes(space.free)} free of ${formatBytes(space.total)})`
        : "";
    return (
        `No space left on the device holding ${dir}${spaceText}: disk full or quota exceeded. ` +
        `Free space there (e.g. clean old files in the temp directory) and retry. ` +
        `Technical detail: ${raw}`
    );
}
