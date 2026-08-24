import { randomUUID } from "node:crypto";
import type { SessionStatus } from "../adapters/sessionInfo";
import { PeerRenderState } from "../application/peerRenderState";
import {
    RenderSessionOwnership,
    type RenderSessionOwnershipOptions,
} from "../application/renderSessionOwnership";
import {
    followRender,
    readRenderSnapshot,
    type FollowRenderOptions,
    type RenderLogRecord,
    type RenderWriter,
} from "../renderLog";

interface SharedRenderStatusOptions {
    writer?: RenderWriter;
    ownership?: RenderSessionOwnershipOptions;
    follow?: Pick<FollowRenderOptions, "intervalMs" | "chunkBytes" | "onReadBytes">;
    ownerPollMs?: number;
    log?: (message: string) => void;
}

interface SharedEntry {
    ownerKey?: string;
    peer: PeerRenderState;
    status: SessionStatus;
    stop?: () => void;
}

/**
 * Projects the live state of sessions owned by another Extension Host.
 *
 * A code-server browser window has its own Extension Host and therefore its own
 * {@link LiveSessions} registry. The render ledger and ownership lease are the
 * machine-wide coordination boundary, so the sessions list must observe those
 * files even when this host has never opened the conversation itself.
 */
export class SharedRenderStatusRegistry {
    private readonly writer: RenderWriter;
    private readonly ownership: RenderSessionOwnership;
    private readonly entries = new Map<string, SharedEntry>();
    private tracked = new Set<string>();
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly onChange?: () => void,
        private readonly options: SharedRenderStatusOptions = {},
    ) {
        this.writer = options.writer ?? { id: randomUUID(), pid: process.pid };
        this.ownership = new RenderSessionOwnership(this.writer, {
            ...options.ownership,
            log: options.log ?? options.ownership?.log,
        });
    }

    get(sessionId: string): SessionStatus | undefined {
        return this.entries.get(sessionId)?.status;
    }

    /** Reconciles the set of stored sessions whose cross-host state is relevant. */
    track(sessionIds: Iterable<string>): void {
        const next = new Set([...sessionIds].filter(Boolean));
        for (const sessionId of this.tracked) {
            if (next.has(sessionId)) continue;
            this.remove(sessionId, false);
        }
        this.tracked = next;
        for (const sessionId of this.tracked) this.reconcile(sessionId);
        this.syncTimer();
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        for (const entry of this.entries.values()) entry.stop?.();
        this.entries.clear();
        this.tracked.clear();
    }

    private syncTimer(): void {
        if (!this.tracked.size) {
            if (this.timer) clearInterval(this.timer);
            this.timer = undefined;
            return;
        }
        if (this.timer) return;
        const intervalMs = Math.max(25, this.options.ownerPollMs ?? 500);
        this.timer = setInterval(() => {
            for (const sessionId of this.tracked) this.reconcile(sessionId);
        }, intervalMs);
        this.timer.unref?.();
    }

    private reconcile(sessionId: string): void {
        const owner = this.ownership.owner(sessionId);
        const ownerAlive = owner !== undefined && this.ownership.alive(owner);
        const current = this.entries.get(sessionId);

        if (!ownerAlive || !owner) {
            if (!current) return;
            if (current.peer.busy) {
                current.peer.refreshLiveness();
                current.stop?.();
                current.stop = undefined;
                current.ownerKey = undefined;
                this.update(sessionId, current, current.peer.attention ?? "error");
            } else if (current.status === "idle") {
                this.remove(sessionId, true);
            }
            return;
        }

        const ownerKey = `${owner.id}:${owner.pid}`;
        if (current?.ownerKey === ownerKey && current.stop) return;
        current?.stop?.();

        const snapshot = readRenderSnapshot(sessionId);
        const peer = new PeerRenderState((writer) => this.ownership.alive(writer));
        peer.restore(snapshot.records, this.writer.id);
        const entry: SharedEntry = {
            ownerKey,
            peer,
            status: this.statusOf(peer),
        };
        this.entries.set(sessionId, entry);
        entry.stop = followRender(
            sessionId,
            snapshot.cursor,
            (records) => this.observe(sessionId, entry, records),
            {
                ...this.options.follow,
                writerId: this.writer.id,
                onError: (error) =>
                    this.options.log?.(
                        `[shared-render-status] ${error instanceof Error ? error.message : String(error)}`,
                    ),
            },
        );
        if (!current || current.status !== entry.status || current.ownerKey !== ownerKey) {
            this.onChange?.();
        }
    }

    private observe(
        sessionId: string,
        entry: SharedEntry,
        records: readonly RenderLogRecord[],
    ): void {
        if (this.entries.get(sessionId) !== entry) return;
        let changed = false;
        for (const record of records) changed = entry.peer.observe(record) || changed;
        if (changed) this.update(sessionId, entry, this.statusOf(entry.peer));
    }

    private statusOf(peer: PeerRenderState): SessionStatus {
        return peer.busy ? "working" : (peer.attention ?? "idle");
    }

    private update(sessionId: string, entry: SharedEntry, status: SessionStatus): void {
        if (entry.status === status || this.entries.get(sessionId) !== entry) return;
        entry.status = status;
        this.onChange?.();
    }

    private remove(sessionId: string, notify: boolean): void {
        const entry = this.entries.get(sessionId);
        if (!entry) return;
        entry.stop?.();
        this.entries.delete(sessionId);
        if (notify) this.onChange?.();
    }
}
