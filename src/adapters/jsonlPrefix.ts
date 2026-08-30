import * as fs from "fs";

/**
 * Reads only a bounded prefix of a JSONL file. Session listing needs metadata,
 * not the complete (sometimes 100+ MB) transcript. The returned text always
 * ends at a newline when the byte cap truncates a file, so callers never parse
 * a partial JSON object.
 */
export async function readJsonlPrefix(file: string, maxBytes: number): Promise<string> {
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(file, "r");
        const stat = await handle.stat();
        const length = Math.min(Math.max(0, maxBytes), stat.size);
        if (length === 0) {
            return "";
        }
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        if (bytesRead < stat.size) {
            const lastNewline = text.lastIndexOf("\n");
            text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
        }
        return text;
    } catch {
        return "";
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/**
 * Reads recent complete JSONL rows from the end of a transcript. Native chat
 * clients restore an initial turns page rather than replaying an entire log;
 * this provides the same bounded-I/O behavior for file-backed adapters.
 */
export async function readJsonlTail(file: string, maxBytes: number): Promise<string> {
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(file, "r");
        const stat = await handle.stat();
        const length = Math.min(Math.max(0, maxBytes), stat.size);
        if (length === 0) {
            return "";
        }
        const position = stat.size - length;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        if (position > 0) {
            const firstNewline = text.indexOf("\n");
            text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
        }
        return text;
    } catch {
        return "";
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/**
 * Reads a bounded window of JSONL rows ending at byte {@link endByte} (exclusive),
 * paginating older history backwards. Returns the complete rows in that window
 * plus the byte offset where the next older page would end (undefined when the
 * start of the file has been reached). The cursor is the base10 string of the
 * byte offset that begins the window just read — pass it back as {@link endByte}
 * (via {@link decodeHistoryCursor}) for the previous page.
 */
export async function readJsonlRange(
    file: string,
    endByte: number,
    maxBytes: number,
): Promise<{ content: string; nextEndByte: number | undefined }> {
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(file, "r");
        const stat = await handle.stat();
        const end = Math.min(Math.max(0, Math.floor(endByte)), stat.size);
        if (end === 0) {
            return { content: "", nextEndByte: undefined };
        }
        const length = Math.min(Math.max(0, maxBytes), end);
        if (length === 0) {
            return { content: "", nextEndByte: undefined };
        }
        const position = end - length;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        // Trim a leading partial row so callers never parse a half JSON object;
        // the dropped bytes belong to the row that continues above this window.
        let nextEndByte: number | undefined = position;
        if (position > 0) {
            const firstNewline = text.indexOf("\n");
            if (firstNewline >= 0) {
                nextEndByte = position + firstNewline + 1;
                text = text.slice(firstNewline + 1);
            } else {
                // No newline in the window — the single row is larger than the
                // page. Return nothing and signal that the next page should
                // start above this window's beginning.
                text = "";
                nextEndByte = position;
            }
        } else {
            // Read from the very start of the file — no older pages remain.
            nextEndByte = undefined;
        }
        return { content: text, nextEndByte };
    } catch {
        return { content: "", nextEndByte: undefined };
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/** Encodes a byte offset as an opaque pagination cursor string. */
export function encodeHistoryCursor(byteOffset: number): string {
    return String(byteOffset);
}

/** Decodes a pagination cursor back to a byte offset, or undefined if absent/invalid. */
export function decodeHistoryCursor(cursor: string | undefined): number | undefined {
    if (!cursor) return undefined;
    const value = Number(cursor);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

interface CachedPrefix<T> {
    size: number;
    mtimeMs: number;
    value: T;
}

/**
 * Process-local metadata cache for immutable transcript files. It also
 * single-flights concurrent readers of the same path, which prevents two
 * surfaces from parsing the same corpus at startup.
 */
export class JsonlMetadataCache<T> {
    private readonly values = new Map<string, CachedPrefix<T>>();
    private readonly pending = new Map<string, Promise<T>>();

    async get(file: string, load: () => Promise<T>): Promise<T> {
        let stat: fs.Stats | undefined;
        try {
            stat = await fs.promises.stat(file);
        } catch {
            /* load handles it */
        }
        const cached = this.values.get(file);
        if (stat && cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            return cached.value;
        }
        const current = this.pending.get(file);
        if (current) {
            return current;
        }
        const promise = load()
            .then((value) => {
                if (stat) {
                    this.values.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
                }
                return value;
            })
            .finally(() => this.pending.delete(file));
        this.pending.set(file, promise);
        return promise;
    }
}
