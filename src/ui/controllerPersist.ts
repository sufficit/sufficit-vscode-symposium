import * as renderLog from "../renderLog";
import { RenderStream } from "./renderStream";

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

/**
 * Persists newly-emitted render messages once the session id is known. Pre-id
 * emits stay buffered in the stream and are flushed here on the first emit
 * after the id arrives (we append everything past state.count).
 */
export function persistEmit(ctx: PersistContext, message: unknown): void {
    const id = ctx.sessionId();
    if (!id) { return; }
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
export function seedRenderLog(ctx: PersistContext, resumeSessionId: string | undefined): boolean {
    if (!resumeSessionId || !renderLog.hasRender(resumeSessionId)) { return false; }
    ctx.state.count = ctx.stream.seed(renderLog.readRender(resumeSessionId));
    return true;
}
