/** Persistence adapter for application render events. */
import * as renderLog from "../renderLog";
import type { RenderLogRecord, RenderWriter } from "../renderLog";
import { RenderStream } from "./renderStream";
import { PendingMessage, recoverPersistedQueue } from "./controllerQueue";
import type { TodoItem } from "../adapters/types";
import { todoSnapshotFromRenderMessage } from "./todoState";

/** Mutable render-log persistence state owned by the controller. */
export interface PersistState {
    /** How many render-log entries are already on disk. */
    count: number;
}

/**
 * Context bag for the render-log persistence helpers: every emitted render
 * message is appended (per session) so a reopened session replays its exact
 * visual — tool rows, diffs, status notices, panels, all of it.
 */
export interface PersistContext {
    sessionId(): string | undefined;
    stream: RenderStream;
    state: PersistState;
    writer?: RenderWriter;
    authoritative?: () => boolean;
}

export interface RestoredRenderLog {
    seeded: boolean;
    pending: PendingMessage[];
    todos?: TodoItem[];
    records: RenderLogRecord[];
    cursor: number;
}

/**
 * Persists newly-emitted render messages once the session id is known. Pre-id
 * emits stay buffered in the stream and are flushed here on the first emit
 * after the id arrives (we append everything past state.count).
 */
export function persistEmit(ctx: PersistContext, message: unknown): void {
    const id = ctx.sessionId();
    if (!id) {
        return;
    }
    // Append THIS message directly. The stream buffer may have shifted
    // (5000-line cap), which makes index-based loops unreliable — so we
    // persist the exact message we received instead of indexing into the
    // buffer. The deferred flush (when sessionId arrives late) still uses
    // the index loop below, which is safe because no shifts happen before
    // the id is known.
    const log = ctx.stream.messages;
    if (ctx.state.count >= log.length) {
        // Already caught up (or seeded from disk) — append the new one.
        renderLog.appendRender(id, message, ctx.writer, ctx.authoritative?.());
    } else {
        // Deferred flush: sessionId just arrived, persist buffered messages
        // that were emitted before we had an id.
        for (let i = ctx.state.count; i < log.length; i++) {
            renderLog.appendRender(id, log[i], ctx.writer, ctx.authoritative?.());
        }
    }
    ctx.state.count = log.length;
}

/**
 * Restores a reopened session's exact visual: if a render log exists for the
 * resume id, preload it into the stream (replayed when the sink binds) and
 * mark it already-persisted. Returns true when seeded, so the caller skips the
 * lossy adapter.history() reconstruction.
 */
export function seedRenderLog(
    ctx: PersistContext,
    resumeSessionId: string | undefined,
): RestoredRenderLog {
    if (!resumeSessionId || !renderLog.hasRender(resumeSessionId)) {
        return { seeded: false, pending: [], records: [], cursor: 0 };
    }
    // The complete JSONL remains on disk for scroll-up pagination. Replaying
    // it here would hydrate thousands of obsolete states before the current
    // one, even though RenderStream itself retains only its last 5000 rows.
    const snapshot = renderLog.readRenderPage(resumeSessionId);
    const persisted = snapshot.messages;
    const { pending, todos } = recoverCurrentState(resumeSessionId, snapshot);
    // A final canonical snapshot overwrites stale queue cards during replay.
    // It is intentionally not appended to disk; it is re-derived on each seed.
    // Whether it was "waiting for a turn" or "held after a failure" isn't
    // durably recorded — a non-empty queue surviving a full restart is always
    // some kind of interrupted state, so it replays as held (see
    // ChatController.seedRenderLog, which sets the live hold flag to match).
    ctx.state.count = ctx.stream.seed([
        ...persisted,
        { type: "queue", items: pending, held: pending.length > 0, busy: false },
    ]);
    return {
        seeded: true,
        pending,
        todos,
        records: snapshot.records,
        cursor: snapshot.cursor,
    };
}

/**
 * Queue and plan are full-state snapshots, not a visual transcript page. Find
 * their last records by walking older pages without replaying those pages into
 * the stream/UI. User rows after the last queue snapshot consume matching
 * legacy pending messages when a final empty queue row was never persisted.
 */
function recoverCurrentState(
    sessionId: string,
    recent: renderLog.RenderLogPage,
): { pending: PendingMessage[]; todos?: TodoItem[] } {
    let todos: TodoItem[] | undefined;
    let queue: unknown;
    const usersAfterQueue: unknown[] = [];
    let page = recent;
    while (true) {
        for (let index = page.messages.length - 1; index >= 0; index--) {
            const message = page.messages[index];
            if (todos === undefined) todos = todoSnapshotFromRenderMessage(message);
            if (queue === undefined) {
                const value = message as { type?: unknown; items?: unknown } | null;
                if (value?.type === "queue" && Array.isArray(value.items)) queue = message;
                else if (value?.type === "user") usersAfterQueue.push(message);
            }
        }
        if ((queue !== undefined && todos !== undefined) || !page.nextCursor) break;
        page = renderLog.readRenderPage(sessionId, page.nextCursor);
    }
    return {
        pending:
            queue === undefined ? [] : recoverPersistedQueue([queue, ...usersAfterQueue.reverse()]),
        todos,
    };
}
