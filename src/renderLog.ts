import * as fs from "node:fs";
import * as path from "node:path";
import { ledgerDir } from "./ledger";

/**
 * Per-session render-log persistence.
 *
 * The chat view is a stream of render messages (the exact objects the webview
 * consumes: text deltas, tool rows + diffs, status notices, panels, thinking
 * blocks, …) buffered in `RenderStream.log`. The ledger only stores role+content
 * messages, so reopening a session used to rebuild a lossy, text-only view.
 *
 * This module persists the full render stream alongside the ledger
 * (`~/.symposium/ledger/<id>/render.jsonl`, one JSON message per line) so a
 * reopened session replays the exact visual it last had — every graphical item
 * included. Append-only and local, mirroring the ledger.
 */

/** Per-message cap: a single oversized payload (e.g. a huge diff) is truncated
 *  with a marker rather than bloating the file unbounded. */
const MAX_LINE_BYTES = 1_000_000;
const DEFAULT_FOLLOW_INTERVAL_MS = 250;
const DEFAULT_FOLLOW_CHUNK_BYTES = 256 * 1024;

/** Identifies the controller process that appended one render record. */
export interface RenderWriter {
    id: string;
    pid: number;
}

/** Decoded on-disk record. Legacy raw JSONL rows have no writer. */
export interface RenderLogRecord {
    message: unknown;
    writer?: RenderWriter;
    /** True when the row was emitted by the elected native-session owner. */
    authoritative?: boolean;
}

/** Point-in-time read plus the byte cursor immediately after its last valid row. */
export interface RenderLogSnapshot {
    messages: unknown[];
    records: RenderLogRecord[];
    cursor: number;
}

/** One complete, newest-first page boundary in the append-only visual log. */
export interface RenderLogPage extends RenderLogSnapshot {
    /** Byte offset for the next older page, or undefined at the beginning. */
    nextCursor?: number;
}

const HISTORY_PAGE_BYTES = 1024 * 1024;

export interface FollowRenderOptions {
    /** Rows written by this controller are skipped when the shared file is tailed. */
    writerId?: string;
    intervalMs?: number;
    chunkBytes?: number;
    /** Test/diagnostic hook proving that only appended bytes are read. */
    onReadBytes?: (bytes: number) => void;
    /** Called on every poll, including polls with no new file data. */
    onPoll?: () => void;
    onError?: (error: unknown) => void;
}

function renderFile(sessionId: string): string {
    return path.join(ledgerDir(sessionId), "render.jsonl");
}

/** Appends one render message to the session's render log (append-only). */
export function appendRender(
    sessionId: string,
    msg: unknown,
    writer?: RenderWriter,
    authoritative?: boolean,
): void {
    if (!sessionId) {
        return;
    }
    try {
        let line = JSON.stringify(storedRecord(msg, writer, authoritative));
        if (line === undefined) {
            return;
        }
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
            // Keep a placeholder so the timeline stays intact without the bulk.
            line = JSON.stringify(
                storedRecord(
                    {
                        type: "event",
                        event: { kind: "text", text: "" },
                        _truncated: true,
                    },
                    writer,
                    authoritative,
                ),
            );
        }
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(renderFile(sessionId), line + "\n");
    } catch {
        // Persistence is best-effort; never let a write error break a live turn.
    }
}

/** True when a render log exists for the session. */
export function hasRender(sessionId: string): boolean {
    try {
        return !!sessionId && fs.existsSync(renderFile(sessionId));
    } catch {
        return false;
    }
}

/** Reads the full render log (parsed messages) for the session, oldest first. */
export function readRender(sessionId: string): unknown[] {
    return readRenderSnapshot(sessionId).messages;
}

/** Reads legacy/new render rows and returns a byte cursor suitable for tailing. */
export function readRenderSnapshot(sessionId: string): RenderLogSnapshot {
    if (!sessionId) {
        return { messages: [], records: [], cursor: 0 };
    }
    let raw: Buffer;
    try {
        raw = fs.readFileSync(renderFile(sessionId));
    } catch {
        return { messages: [], records: [], cursor: 0 };
    }
    const parsed = parseCompleteRecords(raw, true);
    return {
        messages: parsed.records.map((record) => record.message),
        records: parsed.records,
        cursor: parsed.consumedBytes,
    };
}

/**
 * Reads only the recent portion of a visual transcript. Pages begin at a user
 * row, so replaying a page never begins halfway through a tool call or an
 * assistant's streamed answer. Large individual turns can exceed the target
 * size; in that case the whole turn is retained rather than silently lost.
 *
 * `endByte` is the previous page's `nextCursor`. Byte offsets, not message
 * indexes, keep older pages stable while a peer appends new records.
 */
export function readRenderPage(
    sessionId: string,
    endByte?: number,
    options: { pageBytes?: number } = {},
): RenderLogPage {
    const empty: RenderLogPage = { messages: [], records: [], cursor: 0 };
    if (!sessionId) return empty;
    let fd: number | undefined;
    try {
        fd = fs.openSync(renderFile(sessionId), "r");
        const size = fs.fstatSync(fd).size;
        let end = endByte === undefined ? size : Math.min(Math.max(0, endByte), size);
        if (end === 0) return empty;
        let windowBytes = Math.max(1024, options.pageBytes ?? HISTORY_PAGE_BYTES);
        while (true) {
            const start = Math.max(0, end - windowBytes);
            const raw = Buffer.allocUnsafe(end - start);
            const bytesRead = fs.readSync(fd, raw, 0, raw.length, start);
            let complete = raw.subarray(0, bytesRead);
            // A writer may have an unfinished final line. Leave it for the
            // follower rather than projecting a partial JSON object.
            let validTrailingLine = false;
            let trailingRecord: RenderLogRecord | undefined;
            if (endByte === undefined && complete.length && complete.at(-1) !== 0x0a) {
                const lastNewline = complete.lastIndexOf(0x0a);
                const trailing: RenderLogRecord[] = [];
                validTrailingLine = parseLine(complete.subarray(lastNewline + 1), trailing);
                trailingRecord = trailing[0];
                if (validTrailingLine) {
                    // Legacy files may end in a complete row without '\n'.
                    // The offset still points after that valid JSON object.
                } else {
                    if (lastNewline < 0) {
                        if (start === 0) return empty;
                        windowBytes *= 2;
                        continue;
                    }
                    end = start + lastNewline + 1;
                    complete = complete.subarray(0, lastNewline + 1);
                }
            }
            let firstComplete = 0;
            if (start > 0) {
                const newline = complete.indexOf(0x0a);
                if (newline < 0) {
                    windowBytes *= 2;
                    continue;
                }
                firstComplete = newline + 1;
            }
            const rows: Array<{ offset: number; record: RenderLogRecord }> = [];
            for (
                let position = firstComplete, newline = complete.indexOf(0x0a, position);
                newline >= 0;
                position = newline + 1, newline = complete.indexOf(0x0a, position)
            ) {
                const parsed: RenderLogRecord[] = [];
                parseLine(complete.subarray(position, newline), parsed);
                if (parsed.length) rows.push({ offset: start + position, record: parsed[0] });
            }
            if (validTrailingLine && trailingRecord) {
                const lastNewline = complete.lastIndexOf(0x0a);
                rows.push({ offset: start + lastNewline + 1, record: trailingRecord });
            }
            const boundary = rows.findIndex(({ record }) => isHistoryBoundary(record.message));
            if (boundary < 0 && start > 0) {
                windowBytes *= 2;
                continue;
            }
            const selected = rows.slice(boundary < 0 ? 0 : boundary);
            const nextCursor = selected[0]?.offset ?? (start === 0 ? 0 : start + firstComplete);
            const records = selected.map(({ record }) => record);
            return {
                messages: records.map((record) => record.message),
                records,
                cursor: end,
                nextCursor: nextCursor || undefined,
            };
        }
    } catch {
        return empty;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}
function isHistoryBoundary(message: unknown): boolean {
    const type = (message as { type?: unknown } | null)?.type;
    return type === "user" || type === "history";
}

/**
 * Incrementally follows bytes appended by peer Extension Hosts. Unlike the
 * former implementation this never re-reads or re-parses the full JSONL file;
 * each byte after `fromOffset` is read once, in bounded asynchronous chunks.
 */
export function followRender(
    sessionId: string,
    fromOffset: number,
    onMessages: (records: RenderLogRecord[]) => void,
    options: FollowRenderOptions = {},
): () => void {
    const file = renderFile(sessionId);
    const intervalMs = Math.max(25, options.intervalMs ?? DEFAULT_FOLLOW_INTERVAL_MS);
    const chunkBytes = Math.max(1024, options.chunkBytes ?? DEFAULT_FOLLOW_CHUNK_BYTES);
    let offset = Math.max(0, fromOffset);
    let carry = Buffer.alloc(0);
    let disposed = false;
    let running = false;
    let rerun = false;

    const sync = async (): Promise<void> => {
        if (disposed) return;
        if (running) {
            rerun = true;
            return;
        }
        running = true;
        let handle: fs.promises.FileHandle | undefined;
        try {
            const stat = await fs.promises.stat(file);
            if (stat.size < offset) {
                // The append-only ledger was replaced/deleted. Do not replay a
                // replacement from byte zero into an already-built projection.
                offset = stat.size;
                carry = Buffer.alloc(0);
                return;
            }
            if (stat.size === offset) return;
            handle = await fs.promises.open(file, "r");
            while (!disposed && offset < stat.size) {
                const requested = Math.min(chunkBytes, stat.size - offset);
                const chunk = Buffer.allocUnsafe(requested);
                const { bytesRead } = await handle.read(chunk, 0, requested, offset);
                if (bytesRead <= 0) break;
                offset += bytesRead;
                options.onReadBytes?.(bytesRead);
                const data = carry.length
                    ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
                    : chunk.subarray(0, bytesRead);
                const parsed = parseCompleteRecords(data, false);
                carry = Buffer.from(data.subarray(parsed.consumedBytes));
                const external = options.writerId
                    ? parsed.records.filter((record) => record.writer?.id !== options.writerId)
                    : parsed.records;
                if (external.length > 0 && !disposed) {
                    try {
                        onMessages(external);
                    } catch (error) {
                        options.onError?.(error);
                    }
                }
            }
        } catch (error) {
            if (!isFsError(error, "ENOENT")) options.onError?.(error);
        } finally {
            await handle?.close().catch(() => undefined);
            running = false;
            // Reconcile ownership only after newly appended turn-end rows have
            // been projected. Owners append synchronously before releasing the
            // lease; polling first could falsely classify that normal handoff
            // as an abandoned turn.
            if (!disposed) options.onPoll?.();
            if (rerun && !disposed) {
                rerun = false;
                queueMicrotask(() => void sync());
            }
        }
    };

    const timer = setInterval(() => void sync(), intervalMs);
    timer.unref?.();
    void sync();
    return () => {
        disposed = true;
        clearInterval(timer);
    };
}

function storedRecord(message: unknown, writer?: RenderWriter, authoritative?: boolean): unknown {
    if (!writer) return message;
    return {
        _symposiumRender: {
            version: 1,
            writerId: writer.id,
            pid: writer.pid,
            authoritative: authoritative === true,
        },
        message,
    };
}

function decodeRecord(value: unknown): RenderLogRecord {
    if (!value || typeof value !== "object") return { message: value };
    const envelope = value as {
        _symposiumRender?: {
            version?: unknown;
            writerId?: unknown;
            pid?: unknown;
            authoritative?: unknown;
        };
        message?: unknown;
    };
    const meta = envelope._symposiumRender;
    if (
        meta?.version === 1 &&
        typeof meta.writerId === "string" &&
        typeof meta.pid === "number" &&
        Object.prototype.hasOwnProperty.call(envelope, "message")
    ) {
        return {
            message: envelope.message,
            writer: { id: meta.writerId, pid: meta.pid },
            authoritative: meta.authoritative === true,
        };
    }
    return { message: value };
}

function parseCompleteRecords(
    raw: Buffer,
    acceptValidTrailingLine: boolean,
): { records: RenderLogRecord[]; consumedBytes: number } {
    const records: RenderLogRecord[] = [];
    let start = 0;
    for (let index = raw.indexOf(0x0a, start); index >= 0; index = raw.indexOf(0x0a, start)) {
        parseLine(raw.subarray(start, index), records);
        start = index + 1;
    }
    if (acceptValidTrailingLine && start < raw.length) {
        const parsed = parseLine(raw.subarray(start), records);
        if (parsed) start = raw.length;
    }
    return { records, consumedBytes: start };
}

function parseLine(line: Buffer, records: RenderLogRecord[]): boolean {
    const text = line.toString("utf8").trim();
    if (!text) return true;
    try {
        records.push(decodeRecord(JSON.parse(text)));
        return true;
    } catch {
        return false;
    }
}

function isFsError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
}
