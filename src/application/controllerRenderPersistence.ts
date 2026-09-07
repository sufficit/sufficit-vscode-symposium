import { randomUUID } from "node:crypto";
import type { SessionTerminalStatus } from "../adapters/types";
import * as renderLog from "../renderLog";
import type { FollowRenderOptions, RenderLogRecord, RenderWriter } from "../renderLog";
import {
    persistEmit,
    type PersistContext,
    type RestoredRenderLog,
    seedRenderLog,
} from "./controllerPersist";
import { PeerRenderState } from "./peerRenderState";
import { RenderStream } from "./renderStream";
import {
    RenderSessionOwnership,
    type RenderSessionOwnershipOptions,
} from "./renderSessionOwnership";

export interface ControllerRenderPersistenceOptions {
    writer?: RenderWriter;
    ownership?: RenderSessionOwnershipOptions;
    follow?: Pick<FollowRenderOptions, "intervalMs" | "chunkBytes" | "onReadBytes">;
    /** Return false after projecting a normalized replacement yourself. */
    onExternalMessage?: (message: unknown, record: RenderLogRecord) => boolean | void;
    onStatusChanged?: () => void;
    onOwnershipAcquired?: () => void;
    log?: (message: string) => void;
}

/** Owns one controller's stream, disk cursor, peer lifecycle and owner lease. */
export class ControllerRenderPersistence {
    readonly stream: RenderStream;
    private readonly writer: RenderWriter;
    private readonly ownership: RenderSessionOwnership;
    private readonly peer: PeerRenderState;
    private readonly state = { count: 0 };
    private stopFollower: (() => void) | undefined;
    private followedSessionId: string | undefined;
    private owned = false;
    private yielded = false;

    constructor(
        private readonly sessionId: () => string | undefined,
        private readonly options: ControllerRenderPersistenceOptions = {},
    ) {
        this.writer = options.writer ?? { id: randomUUID(), pid: process.pid };
        this.ownership = new RenderSessionOwnership(this.writer, {
            ...options.ownership,
            log: options.log ?? options.ownership?.log,
        });
        this.peer = new PeerRenderState((writer) => this.peerWriterOwnsSession(writer));
        this.stream = new RenderStream((message) => this.persist(message));
    }

    get peerBusy(): boolean {
        return this.peer.busy;
    }

    get peerAttention(): SessionTerminalStatus | undefined {
        return this.peer.attention;
    }

    get isOwner(): boolean {
        const id = this.sessionId();
        return !id || (this.owned && this.ownership.owns(id));
    }

    restore(resumeSessionId: string | undefined): RestoredRenderLog {
        const restored = seedRenderLog(this.context(), resumeSessionId);
        if (!resumeSessionId) return restored;
        const activeStart = this.peer.restore(restored.records, this.writer.id);
        if (activeStart !== undefined) this.stream.ingestPersisted(activeStart);
        // Synthetic queue/active-turn rows are already represented on disk (or
        // deliberately transient), so a later local emit must not flush them.
        this.state.count = this.stream.messages.length;
        this.follow(resumeSessionId, restored.cursor);
        this.recoverAbandonedPeerTurn();
        return restored;
    }

    /** True when this controller may invoke the adapter for the native session. */
    canDispatch(): boolean {
        const id = this.sessionId();
        if (!id) return true;
        // A fresh local action is an explicit reason to compete again after
        // this controller yielded an idle session to its peers.
        this.yielded = false;
        this.ensureFollowing(id);
        if (this.owned && this.ownership.owns(id)) return true;
        const acquired = this.ownership.ensure(id);
        if (acquired) this.becomeOwner(true);
        return acquired;
    }

    /**
     * Returns an idle native session to the shared owner pool. The adapter
     * object may stay warm in this controller; a later send reacquires the
     * lease before it can resume the native session.
     */
    releaseOwnership(): void {
        this.ownership.release();
        this.owned = false;
        this.yielded = true;
    }

    dispose(): void {
        this.stopFollower?.();
        this.stopFollower = undefined;
        this.followedSessionId = undefined;
        this.ownership.release();
        this.owned = false;
    }

    private context(): PersistContext {
        return {
            sessionId: this.sessionId,
            stream: this.stream,
            state: this.state,
            writer: this.writer,
            authoritative: () => this.isOwner,
        };
    }

    private persist(message: unknown): void {
        const id = this.sessionId();
        if (id) this.ensureFollowing(id);
        if (eventKind(message) === "turn-start" && this.peer.localTurnStarted()) {
            this.options.onStatusChanged?.();
        }
        persistEmit(this.context(), message);
    }

    private ensureFollowing(sessionId: string): void {
        if (this.followedSessionId === sessionId && this.stopFollower) return;
        const cursor = renderLog.readRenderSnapshot(sessionId).cursor;
        this.follow(sessionId, cursor);
    }

    private follow(sessionId: string, cursor: number): void {
        this.stopFollower?.();
        if (this.followedSessionId && this.followedSessionId !== sessionId) {
            this.ownership.release();
            this.yielded = false;
        }
        this.followedSessionId = sessionId;
        this.owned = this.ownership.ensure(sessionId);
        this.stopFollower = renderLog.followRender(
            sessionId,
            cursor,
            (records) => {
                let statusChanged = false;
                for (const record of records) {
                    statusChanged = this.peer.observe(record) || statusChanged;
                    const ingestRaw = this.options.onExternalMessage?.(record.message, record);
                    if (ingestRaw !== false) this.stream.ingestPersisted(record.message);
                }
                this.state.count = this.stream.messages.length;
                if (statusChanged) this.options.onStatusChanged?.();
            },
            {
                ...this.options.follow,
                writerId: this.writer.id,
                onPoll: () => this.pollOwnership(sessionId),
                onError: (error) =>
                    this.options.log?.(
                        `[render-follow] ${error instanceof Error ? error.message : String(error)}`,
                    ),
            },
        );
    }

    private pollOwnership(sessionId: string): void {
        const statusChanged = this.peer.refreshLiveness();
        if (statusChanged) this.options.onStatusChanged?.();
        if (this.owned && !this.ownership.owns(sessionId)) {
            this.owned = false;
        }
        if (!this.owned && !this.yielded && this.ownership.ensure(sessionId)) {
            this.becomeOwner(false);
        }
        this.recoverAbandonedPeerTurn();
    }

    /**
     * A live Extension Host is not sufficient proof that its old turn is still
     * running: the controller can disappear or yield its lease while the host
     * process remains alive for days. The writer must still own this session.
     */
    private peerWriterOwnsSession(writer: RenderWriter | undefined): boolean {
        const sessionId = this.followedSessionId ?? this.sessionId();
        if (!sessionId || !writer || !this.ownership.alive(writer)) return false;
        const owner = this.ownership.owner(sessionId);
        return owner?.id === writer.id && owner.pid === writer.pid;
    }

    private becomeOwner(fromDispatch: boolean): void {
        const changed = !this.owned;
        this.owned = true;
        this.yielded = false;
        if (changed && !fromDispatch) this.options.onOwnershipAcquired?.();
    }

    /**
     * A dead Extension Host cannot write its own error/turn-end. The first
     * follower that acquires the stale lease closes that durable gap so every
     * window sees an actionable explanation instead of a conversation that
     * merely stops animating.
     */
    private recoverAbandonedPeerTurn(): void {
        if (!this.isOwner) return;
        const abandoned = this.peer.takeAbandonedTurn();
        if (!abandoned) return;
        this.stream.emit({
            type: "event",
            event: {
                kind: "error",
                message:
                    "The agent host disconnected before reporting a result. The turn was stopped and can be retried.",
                retryable: true,
            },
        });
        this.stream.emit({
            type: "event",
            event: { kind: "turn-end", ...abandoned },
        });
        this.options.onStatusChanged?.();
    }
}

function eventKind(message: unknown): string | undefined {
    const value = message as { type?: unknown; event?: { kind?: unknown } } | null;
    return value?.type === "event" && typeof value.event?.kind === "string"
        ? value.event.kind
        : undefined;
}
