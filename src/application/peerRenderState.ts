import type { SessionTerminalStatus } from "../adapters/types";
import type { RenderLogRecord, RenderWriter } from "../renderLog";

interface RenderEventEnvelope {
    type?: unknown;
    event?: {
        kind?: unknown;
        logicalTurnId?: unknown;
        fatal?: unknown;
        historical?: unknown;
        terminal?: unknown;
        severity?: unknown;
    };
}

/** Minimal lifecycle projected from render rows authored by another controller. */
export class PeerRenderState {
    private active = false;
    private activeWriter: RenderWriter | undefined;
    private activeTurnId: string | undefined;
    private activeStart: unknown;
    private terminal: SessionTerminalStatus | undefined;
    private abandonedTurnId: string | undefined;
    private abandoned = false;

    constructor(private readonly writerAlive: (writer: RenderWriter | undefined) => boolean) {}

    get busy(): boolean {
        return this.active;
    }

    get attention(): SessionTerminalStatus | undefined {
        return this.active ? undefined : this.terminal;
    }

    /** Restores only a demonstrably-live unmatched peer turn, never historical errors. */
    restore(records: readonly RenderLogRecord[], ownWriterId: string): unknown | undefined {
        this.reset();
        for (const record of records) {
            if (record.writer?.id === ownWriterId) continue;
            this.apply(record, false);
        }
        if (this.active && this.activeWriter && !this.writerAlive(this.activeWriter)) {
            this.abandonActiveTurn();
            return undefined;
        }
        if (!this.active || !this.activeWriter) {
            this.reset();
            return undefined;
        }
        return this.activeStart;
    }

    /** Applies one newly-tailed peer row and reports whether list status changed. */
    observe(record: RenderLogRecord): boolean {
        const before = `${this.active}:${this.terminal ?? ""}`;
        this.apply(record, true);
        return before !== `${this.active}:${this.terminal ?? ""}`;
    }

    /** Clears a peer turn whose process disappeared without writing turn-end. */
    refreshLiveness(): boolean {
        if (!this.active || !this.activeWriter || this.writerAlive(this.activeWriter)) return false;
        this.abandonActiveTurn();
        return true;
    }

    /** Returns a peer turn that died without a terminal boundary, once. */
    takeAbandonedTurn(): { logicalTurnId?: string } | undefined {
        if (this.terminal !== "error" || !this.abandoned) return undefined;
        const logicalTurnId = this.abandonedTurnId;
        this.abandoned = false;
        this.abandonedTurnId = undefined;
        return logicalTurnId ? { logicalTurnId } : {};
    }

    /** A locally-owned turn supersedes any stale peer projection. */
    localTurnStarted(): boolean {
        if (!this.active && this.terminal === undefined) return false;
        this.reset();
        return true;
    }

    private apply(record: RenderLogRecord, acceptWriterlessLiveStart: boolean): void {
        const envelope = record.message as RenderEventEnvelope | null;
        if (envelope?.type !== "event" || !envelope.event) return;
        const event = envelope.event;
        const kind = event.kind;
        if (kind === "turn-start") {
            if (!record.writer && !acceptWriterlessLiveStart) return;
            this.active = true;
            this.activeWriter = record.writer;
            this.activeTurnId = optionalString(event.logicalTurnId);
            this.activeStart = record.message;
            this.terminal = undefined;
            return;
        }
        if (kind === "turn-end") {
            const ended = optionalString(event.logicalTurnId);
            if (this.active && (!ended || !this.activeTurnId || ended === this.activeTurnId)) {
                this.active = false;
                this.activeWriter = undefined;
                this.activeTurnId = undefined;
                this.activeStart = undefined;
            }
            return;
        }
        if (!this.active) return;
        if (kind === "error" && event.fatal !== false && event.historical !== true) {
            this.terminal = "error";
        } else if (
            kind === "status-notice" &&
            event.terminal === true &&
            event.severity === "warning" &&
            this.terminal !== "error"
        ) {
            this.terminal = "warning";
        }
    }

    private reset(): void {
        this.active = false;
        this.activeWriter = undefined;
        this.activeTurnId = undefined;
        this.activeStart = undefined;
        this.terminal = undefined;
        this.abandonedTurnId = undefined;
        this.abandoned = false;
    }

    private abandonActiveTurn(): void {
        this.abandonedTurnId = this.activeTurnId;
        this.abandoned = true;
        this.active = false;
        this.activeWriter = undefined;
        this.activeTurnId = undefined;
        this.activeStart = undefined;
        this.terminal = "error";
    }
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}
