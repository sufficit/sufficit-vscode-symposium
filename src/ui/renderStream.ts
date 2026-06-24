/**
 * Render-stream buffer for a chat session: keeps a replayable log of render
 * messages, fans each out to the active webview sink (if any) plus any read-only
 * followers, and replays the buffer to a sink/observer on (re)bind so a late
 * joiner or a reattached webview sees the full conversation.
 *
 * Owned by ChatController as a collaborator so the controller file stays focused
 * on turn/session logic rather than stream plumbing.
 */
export class RenderStream {
    private readonly log: unknown[] = [];
    private sink: ((message: unknown) => void) | null = null;
    private readonly observers = new Set<(message: unknown) => void>();

    /**
     * Optional persistence hook, called for every emitted render message so the
     * full visual can be saved per session and replayed on reopen. Best-effort:
     * never throws into the emit path.
     */
    constructor(private readonly onPersist?: (message: unknown) => void) { }

    /**
     * Preloads prior render messages into the buffer WITHOUT persisting or fanning
     * them out — used to restore a reopened session's exact visual before the
     * webview sink binds (bindSink then replays the seeded log). Returns the new
     * buffer length so callers can mark how much is already persisted.
     */
    seed(messages: unknown[]): number {
        for (const m of messages) { this.log.push(m); }
        return this.log.length;
    }

    /** True while a webview sink is bound. */
    get hasSink(): boolean {
        return this.sink !== null;
    }

    /** The buffered render log (read-only use, e.g. transcript building). */
    get messages(): unknown[] {
        return this.log;
    }

    /** Binds the active webview sink and replays the buffered log to it. */
    bindSink(sink: (message: unknown) => void): void {
        this.sink = sink;
        for (const message of this.log) {
            sink(message);
        }
    }

    /** Unbinds the webview sink (the process keeps running). */
    clearSink(): void {
        this.sink = null;
    }

    /** Adds a read-only follower, replays the log to it, returns an unsubscribe. */
    addObserver(observer: (message: unknown) => void): () => void {
        this.observers.add(observer);
        for (const message of this.log) {
            observer(message);
        }
        return () => { this.observers.delete(observer); };
    }

    /** Buffers a render message and fans it out to the sink + all observers. */
    emit(message: unknown): void {
        this.log.push(message);
        if (this.log.length > 5000) {
            this.log.shift();
        }
        this.sink?.(message);
        for (const observer of this.observers) {
            observer(message);
        }
        try { this.onPersist?.(message); } catch { /* persistence is best-effort */ }
    }

    /** Sends a message to the webview sink only (not buffered, not fanned out). */
    toSink(message: unknown): void {
        this.sink?.(message);
    }
}
