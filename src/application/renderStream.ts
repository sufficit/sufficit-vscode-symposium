/** Application-owned persisted render event stream.
 *
 * Keeps a bounded log for transcript/persistence purposes and fans new events
 * out to application observers. UI reconstruction belongs to the AHP runtime;
 * this stream no longer owns webview sinks or UI replay.
 *
 * Owned by ChatController as a collaborator so the controller file stays focused
 * on turn/session logic rather than stream plumbing.
 */
export class RenderStream {
    private readonly log: unknown[] = [];
    private readonly observers = new Set<(message: unknown) => void>();

    /**
     * Optional persistence hook, called for every emitted render message so the
     * full visual can be saved per session and replayed on reopen. Best-effort:
     * never throws into the emit path.
     */
    constructor(private readonly onPersist?: (message: unknown) => void) {}

    /**
     * Preloads prior render messages into the buffer WITHOUT persisting or fanning
     * them out — used to restore a reopened session's exact visual before the
     * projection is rebuilt. Returns the new buffer length so callers can mark
     * how much is already persisted.
     */
    seed(messages: unknown[]): number {
        // A session interrupted mid-turn (window closed, crash) persists a
        // "turn-start" with no matching "turn-end". Replaying that on reopen would
        // flip the webview into a stuck "thinking" state forever. Drop any trailing
        // turn-start that is never closed by a later turn-end before seeding.
        const sanitized = neutralizeSupersededErrors(dropOrphanTurnStart(messages));
        for (const m of sanitized) {
            this.log.push(m);
        }
        return this.log.length;
    }

    /** The buffered render log (read-only use, e.g. transcript building). */
    get messages(): unknown[] {
        return this.log;
    }

    /** Adds a read-only follower, replays the log to it, returns an unsubscribe. */
    addObserver(observer: (message: unknown) => void): () => void {
        this.observers.add(observer);
        for (const message of this.log) {
            observer(message);
        }
        return () => {
            this.observers.delete(observer);
        };
    }

    /** Adds a live-only observer without replaying historical render messages. */
    addLiveObserver(observer: (message: unknown) => void): () => void {
        this.observers.add(observer);
        return () => {
            this.observers.delete(observer);
        };
    }

    /** Buffers a render message and fans it out to application observers. */
    emit(message: unknown): void {
        this.log.push(message);
        if (this.log.length > 5000) {
            this.log.shift();
        }
        for (const observer of this.observers) {
            observer(message);
        }
        try {
            this.onPersist?.(message);
        } catch {
            /* persistence is best-effort */
        }
    }

    /** Sends a transient application signal without persisting or replaying it. */
    notify(message: unknown): void {
        for (const observer of this.observers) observer(message);
    }
}

/** The render-event kind, if this message is an event envelope. */
function eventKind(m: unknown): string | undefined {
    const ev = m as { type?: string; event?: { kind?: string } };
    if (ev?.type === "event" && typeof ev.event?.kind === "string") {
        return ev.event.kind;
    }
    return undefined;
}

/**
 * Removes any "turn-start" event that is never followed by a matching "turn-end"
 * — the signature of a session interrupted mid-turn. Without this the restored
 * projection could remain stuck in a running state. Balanced
 * turn-start/turn-end pairs are kept intact.
 */
function dropOrphanTurnStart(messages: unknown[]): unknown[] {
    // Find indexes of unmatched turn-starts by scanning with a simple depth count.
    const orphans = new Set<number>();
    const open: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        const kind = eventKind(messages[i]);
        if (kind === "turn-start") {
            open.push(i);
        } else if (kind === "turn-end") {
            open.pop();
        }
    }
    for (const idx of open) {
        orphans.add(idx);
    }
    if (orphans.size === 0) {
        return messages;
    }
    return messages.filter((_, i) => !orphans.has(i));
}

/**
 * Marks every "error" event as historical, except the current terminal error
 * (optionally followed by its mandatory turn-end). Without this, restoring a
 * saved session would expose a live Retry action for EVERY past
 * stall/error it ever hit — even ones long since superseded by a successful
 * retry and further conversation.
 * A trailing turn-end does not supersede the error: it only releases the busy
 * state, so the retry action must survive window reload/reconnection.
 */
function neutralizeSupersededErrors(messages: unknown[]): unknown[] {
    let currentErrorIdx = messages.length - 1;
    while (currentErrorIdx >= 0 && eventKind(messages[currentErrorIdx]) === "turn-end") {
        currentErrorIdx--;
    }
    if (eventKind(messages[currentErrorIdx]) !== "error") {
        currentErrorIdx = -1;
    }

    let sawSupersededError = false;
    const result = messages.map((m, i) => {
        if (i === currentErrorIdx || eventKind(m) !== "error") {
            return m;
        }
        sawSupersededError = true;
        const envelope = m as { type: string; event: Record<string, unknown> };
        return { ...envelope, event: { ...envelope.event, historical: true } };
    });
    return sawSupersededError ? result : messages;
}
