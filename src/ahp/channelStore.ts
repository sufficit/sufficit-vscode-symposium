import type {
    ActionEnvelope,
    ActionOrigin,
    Snapshot,
    StateAction,
    URI,
} from "@microsoft/agent-host-protocol";

type AhpState = Snapshot["state"];

/** Pure state transition for one AHP channel. */
export type AhpChannelReducer<S extends AhpState, A extends StateAction = StateAction> = (
    state: S,
    action: A,
) => S;

interface RegisteredChannel {
    state: AhpState;
    reduce: (state: AhpState, action: StateAction) => AhpState;
}

export interface AhpReconnectReplay {
    type: "replay";
    actions: ActionEnvelope[];
    missing: URI[];
}

export interface AhpReconnectSnapshot {
    type: "snapshot";
    snapshots: Snapshot[];
    missing: URI[];
}

export type AhpReconnectResult = AhpReconnectReplay | AhpReconnectSnapshot;

export interface AhpStateStoreOptions {
    /** Number of recent envelopes retained for reconnect replay. */
    replayCapacity?: number;
    /** Reports a failed subscriber without letting it break other clients. */
    onListenerError?: (error: unknown, envelope: ActionEnvelope) => void;
}

/**
 * Transport-independent authoritative state core for an AHP host.
 *
 * It deliberately owns only the protocol invariants shared by every transport:
 * one global server sequence, immutable channel reductions, snapshots,
 * bounded reconnect replay and fan-out to channel subscribers. JSON-RPC,
 * WebSocket authentication and Symposium side effects live above this layer.
 */
export class AhpStateStore {
    private readonly channels = new Map<URI, RegisteredChannel>();
    private readonly listeners = new Map<URI, Set<(envelope: ActionEnvelope) => void>>();
    private readonly replayCapacity: number;
    private readonly onListenerError:
        | ((error: unknown, envelope: ActionEnvelope) => void)
        | undefined;
    private readonly replayBuffer: ActionEnvelope[] = [];
    private sequence = 0;

    constructor(options: AhpStateStoreOptions = {}) {
        const requested = options.replayCapacity ?? 10_000;
        if (!Number.isSafeInteger(requested) || requested < 0) {
            throw new RangeError("replayCapacity must be a non-negative safe integer");
        }
        this.replayCapacity = requested;
        this.onListenerError = options.onListenerError;
    }

    get serverSeq(): number {
        return this.sequence;
    }

    has(resource: URI): boolean {
        return this.channels.has(resource);
    }

    resources(): URI[] {
        return [...this.channels.keys()];
    }

    register<S extends AhpState, A extends StateAction>(
        resource: URI,
        initialState: S,
        reducer: AhpChannelReducer<S, A>,
    ): void {
        if (this.channels.has(resource)) {
            throw new Error(`AHP channel already registered: ${resource}`);
        }
        this.channels.set(resource, {
            state: initialState,
            reduce: (state, action) => reducer(state as S, action as A),
        });
    }

    remove(resource: URI): boolean {
        this.listeners.delete(resource);
        return this.channels.delete(resource);
    }

    snapshot(resource: URI): Snapshot {
        const channel = this.requireChannel(resource);
        return {
            resource,
            state: channel.state,
            fromSeq: this.sequence,
        };
    }

    snapshots(resources: readonly URI[]): { snapshots: Snapshot[]; missing: URI[] } {
        const snapshots: Snapshot[] = [];
        const missing: URI[] = [];
        for (const resource of resources) {
            if (this.channels.has(resource)) {
                snapshots.push(this.snapshot(resource));
            } else {
                missing.push(resource);
            }
        }
        return { snapshots, missing };
    }

    allSnapshots(): Snapshot[] {
        return this.resources().map((resource) => this.snapshot(resource));
    }

    retainedActions(): ActionEnvelope[] {
        return [...this.replayBuffer];
    }

    /** Restores sequence/replay metadata after callers have registered snapshots. */
    restoreClock(serverSeq: number, retained: readonly ActionEnvelope[] = []): void {
        if (!Number.isSafeInteger(serverSeq) || serverSeq < this.sequence) {
            throw new RangeError("serverSeq must be a safe integer at or above current sequence");
        }
        let previous = 0;
        for (const envelope of retained) {
            if (
                !Number.isSafeInteger(envelope.serverSeq) ||
                envelope.serverSeq <= previous ||
                envelope.serverSeq > serverSeq
            ) {
                throw new Error("retained AHP actions must be strictly monotonic and bounded");
            }
            previous = envelope.serverSeq;
        }
        this.sequence = serverSeq;
        this.replayBuffer.splice(
            0,
            this.replayBuffer.length,
            ...retained.slice(-this.replayCapacity),
        );
    }

    /**
     * Applies and broadcasts an accepted action, or echoes a rejected client
     * action without mutating state so optimistic clients can roll it back.
     */
    dispatch(
        resource: URI,
        action: StateAction,
        options: { origin?: ActionOrigin; rejectionReason?: string } = {},
    ): ActionEnvelope {
        const channel = this.requireChannel(resource);
        if (!options.rejectionReason) {
            channel.state = channel.reduce(channel.state, action);
        }
        const envelope: ActionEnvelope = {
            channel: resource,
            action,
            serverSeq: ++this.sequence,
            origin: options.origin,
            ...(options.rejectionReason ? { rejectionReason: options.rejectionReason } : {}),
        };
        this.remember(envelope);
        for (const listener of this.listeners.get(resource) ?? []) {
            try {
                listener(envelope);
            } catch (error) {
                this.onListenerError?.(error, envelope);
            }
        }
        return envelope;
    }

    /**
     * Subscribes to future envelopes. The caller should obtain snapshot()
     * immediately before this call in the same synchronous request handler.
     */
    subscribe(resource: URI, listener: (envelope: ActionEnvelope) => void): () => void {
        this.requireChannel(resource);
        let set = this.listeners.get(resource);
        if (!set) {
            set = new Set();
            this.listeners.set(resource, set);
        }
        set.add(listener);
        return () => {
            set?.delete(listener);
            if (set?.size === 0) {
                this.listeners.delete(resource);
            }
        };
    }

    reconnect(lastSeenServerSeq: number, resources: readonly URI[]): AhpReconnectResult {
        if (!Number.isSafeInteger(lastSeenServerSeq) || lastSeenServerSeq < 0) {
            throw new RangeError("lastSeenServerSeq must be a non-negative safe integer");
        }
        const existing = resources.filter((resource) => this.channels.has(resource));
        const missing = resources.filter((resource) => !this.channels.has(resource));
        const oldestAvailable = this.replayBuffer[0]?.serverSeq ?? this.sequence + 1;
        const canReplay =
            lastSeenServerSeq <= this.sequence && lastSeenServerSeq >= oldestAvailable - 1;

        if (!canReplay) {
            return { type: "snapshot", ...this.snapshots(existing), missing };
        }

        const wanted = new Set(existing);
        return {
            type: "replay",
            actions: this.replayBuffer.filter(
                (envelope) =>
                    envelope.serverSeq > lastSeenServerSeq && wanted.has(envelope.channel),
            ),
            missing,
        };
    }

    private requireChannel(resource: URI): RegisteredChannel {
        const channel = this.channels.get(resource);
        if (!channel) {
            throw new Error(`Unknown AHP channel: ${resource}`);
        }
        return channel;
    }

    private remember(envelope: ActionEnvelope): void {
        if (this.replayCapacity === 0) {
            return;
        }
        this.replayBuffer.push(envelope);
        if (this.replayBuffer.length > this.replayCapacity) {
            this.replayBuffer.splice(0, this.replayBuffer.length - this.replayCapacity);
        }
    }
}
