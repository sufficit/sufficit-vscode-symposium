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
        if (length === 0) { return ""; }
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
        if (length === 0) { return ""; }
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
        try { stat = await fs.promises.stat(file); } catch { /* load handles it */ }
        const cached = this.values.get(file);
        if (stat && cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            return cached.value;
        }
        const current = this.pending.get(file);
        if (current) { return current; }
        const promise = load().then((value) => {
            if (stat) {
                this.values.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
            }
            return value;
        }).finally(() => this.pending.delete(file));
        this.pending.set(file, promise);
        return promise;
    }
}