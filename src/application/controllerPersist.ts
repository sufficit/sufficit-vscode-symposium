/** Persistence adapter for application render events. */
import * as renderLog from "../renderLog";
import { RenderStream } from "./renderStream";
import { PendingMessage, recoverPersistedQueue } from "./controllerQueue";

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
}

export interface RestoredRenderLog {
    seeded: boolean;
    pending: PendingMessage[];
    /** Parsed on-disk entries, excluding the synthetic queue snapshot. */
    persistedCount: number;
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
        renderLog.appendRender(id, message);
    } else {
        // Deferred flush: sessionId just arrived, persist buffered messages
        // that were emitted before we had an id.
        for (let i = ctx.state.count; i < log.length; i++) {
            renderLog.appendRender(id, log[i]);
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
        return { seeded: false, pending: [], persistedCount: 0 };
    }
    const persisted = renderLog.readRender(resumeSessionId);
    const pending = recoverPersistedQueue(persisted);
    // A final canonical snapshot overwrites stale queue cards during replay.
    // It is intentionally not appended to disk; it is re-derived on each seed.
    ctx.state.count = ctx.stream.seed([...persisted, { type: "queue", items: pending }]);
    return { seeded: true, pending, persistedCount: persisted.length };
}

/**
 * Mirrors render events written by a still-running peer Extension Host into a
 * reopened controller. Ingested entries skip persistence, while `state.count`
 * advances with the local buffer so the next locally-owned emit is appended
 * once instead of flushing the mirrored entries back to disk.
 */
export function followPersistedRenderLog(
    ctx: PersistContext,
    resumeSessionId: string,
    persistedCount: number,
    intervalMs = 500,
): () => void {
    return renderLog.followRender(
        resumeSessionId,
        persistedCount,
        (messages) => {
            for (const message of messages) {
                ctx.stream.ingestPersisted(message);
            }
            ctx.state.count = ctx.stream.messages.length;
        },
        intervalMs,
    );
}
