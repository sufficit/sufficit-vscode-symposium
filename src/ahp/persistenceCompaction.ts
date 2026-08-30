import type { ActionEnvelope, ChatState, Snapshot, URI } from "@microsoft/agent-host-protocol";
import type { AhpRuntimeExport } from "./hostRuntime";
import { byteLength, sessionOwnedSnapshots } from "./persistenceValidation";

/**
 * Auto-compaction passes applied on the write path before a runtime export is
 * serialized: re-snapshotting oversized sessions and trimming retained actions.
 * Both are pure functions over the exported state; the caller supplies the byte
 * caps and the collaborators taken from its persistence options.
 */
export interface AhpCompactionLimits {
    maxBytes: number;
    maxSessionBytes: number;
    snapshotResources?: (resources: readonly URI[]) => Snapshot[];
    onDiagnostic?: (message: string) => void;
}

/**
 * Bounds the aggregate cost of historical chat snapshots. Individual sessions
 * can each be below maxSessionBytes while their combined persisted state still
 * consumes the entire global cap (the real-world 40-session failure mode).
 *
 * The JSON/render-log repositories remain authoritative; persisted AHP state is
 * only a reconnect cache. Keep a useful recent tail per chat and reclaim older
 * turns before retained-action trimming, leaving headroom for fresh actions.
 */
export function compactHistoricalSnapshots(
    state: AhpRuntimeExport,
    limits: AhpCompactionLimits,
): AhpRuntimeExport {
    const targetBytes = Math.floor(limits.maxBytes * 0.75);
    let estimatedBytes = byteLength({ ...state, retainedActions: [] as ActionEnvelope[] });
    if (estimatedBytes <= targetBytes) return state;

    const snapshots = [...state.snapshots];
    let removedTurns = 0;
    const changed = new Set<number>();
    // Prefer a useful recent tail. If that is still too large, retain at least
    // one completed turn per chat so restored sessions never appear fabricated.
    for (const minimumTurns of [20, 1]) {
        const candidates = snapshots
            .map((snapshot, index) => ({
                index,
                snapshot,
                turns: Array.isArray((snapshot.state as { turns?: unknown }).turns)
                    ? ([...(snapshot.state as { turns: unknown[] }).turns] as unknown[])
                    : undefined,
            }))
            .filter(
                (
                    candidate,
                ): candidate is {
                    index: number;
                    snapshot: Snapshot;
                    turns: unknown[];
                } => (candidate.turns?.length ?? 0) > minimumTurns,
            )
            .sort((left, right) => byteLength(right.turns) - byteLength(left.turns));

        for (const candidate of candidates) {
            if (estimatedBytes <= targetBytes) break;
            let removeCount = 0;
            let reclaimed = 0;
            while (
                candidate.turns.length - removeCount > minimumTurns &&
                estimatedBytes - reclaimed > targetBytes
            ) {
                reclaimed += byteLength(candidate.turns[removeCount]) + 1;
                removeCount++;
            }
            if (removeCount === 0) continue;
            const nextTurns = candidate.turns.slice(removeCount);
            snapshots[candidate.index] = {
                ...candidate.snapshot,
                state: {
                    ...(candidate.snapshot.state as unknown as Record<string, unknown>),
                    turns: nextTurns,
                } as Snapshot["state"],
            };
            estimatedBytes -= reclaimed;
            removedTurns += removeCount;
            changed.add(candidate.index);
        }
        if (estimatedBytes <= targetBytes) break;
    }

    if (removedTurns === 0) return state;
    limits.onDiagnostic?.(
        `[ahp] compacted ${removedTurns} historical turn(s) across ${changed.size} chat snapshot(s) for the total persistence budget`,
    );
    return { ...state, snapshots };
}

/**
 * Re-snapshots any session whose owned snapshots exceed the per-session
 * cap, so validateRuntime does not throw on a long-running host. If a fresh
 * snapshot still exceeds the cap (because the live chat turn history itself
 * is too large), the oldest turns are trimmed from the persisted view until
 * it fits — the authoritative history is never lost, since it lives in the
 * JSON session repository and is re-loaded on each open. Returns the
 * runtime export with snapshots potentially replaced/trimmed. Complexity is
 * O(sessions * snapshots) plus a bounded turn-trim pass per oversized chat.
 */
export function resnapshotOversizedSessions(
    state: AhpRuntimeExport,
    limits: AhpCompactionLimits,
): AhpRuntimeExport {
    const snapshotFn = limits.snapshotResources;
    if (!snapshotFn) return state;
    const snapshots = state.snapshots;
    const oversized = state.sessions.filter((handle) => {
        const owned = sessionOwnedSnapshots(snapshots, handle);
        return owned.length > 0 && byteLength(owned) > limits.maxSessionBytes;
    });
    if (oversized.length === 0) return state;
    const replacements = new Map<URI, Snapshot>();
    let resnapshotCount = 0;
    let trimmedTurns = 0;
    for (const handle of oversized) {
        const ownedResources = sessionOwnedSnapshots(snapshots, handle).map((s) => s.resource);
        for (const snapshot of snapshotFn(ownedResources)) {
            // Clamp fromSeq to the exported serverSeq: the runtime may have
            // advanced between exportState() (tick N) and this deferred
            // serialization (tick N+1), which would make the fresh snapshot's
            // fromSeq exceed state.serverSeq and fail validation.
            const clamped =
                snapshot.fromSeq > state.serverSeq
                    ? { ...snapshot, fromSeq: state.serverSeq }
                    : snapshot;
            replacements.set(clamped.resource, clamped);
            resnapshotCount++;
        }
        // If the fresh snapshot is still oversized (live state is large),
        // trim oldest chat turns until the session's owned bytes fit. Only
        // chat snapshots carry a `turns` array; others are left untouched.
        const ownedFresh = sessionOwnedSnapshots(
            snapshots.map((s) => replacements.get(s.resource) ?? s),
            handle,
        );
        if (byteLength(ownedFresh) <= limits.maxSessionBytes) continue;
        const budget =
            limits.maxSessionBytes -
            byteLength(
                ownedFresh.filter((s) => !Array.isArray((s.state as { turns?: unknown }).turns)),
            );
        for (const snapshot of ownedFresh) {
            const chatState = snapshot.state as Partial<ChatState>;
            if (!Array.isArray(chatState.turns) || chatState.turns.length === 0) continue;
            let turns = [...chatState.turns];
            while (
                turns.length > 1 &&
                Buffer.byteLength(JSON.stringify(turns)) > Math.max(0, budget)
            ) {
                turns = turns.slice(1);
            }
            if (turns.length < chatState.turns.length) {
                trimmedTurns += chatState.turns.length - turns.length;
                replacements.set(snapshot.resource, {
                    ...snapshot,
                    state: { ...chatState, turns } as ChatState,
                });
            }
        }
    }
    if (replacements.size === 0) return state;
    const parts = [`re-snapshoted ${resnapshotCount} channel(s)`];
    if (trimmedTurns > 0) parts.push(`trimmed ${trimmedTurns} old turn(s)`);
    limits.onDiagnostic?.(
        `[ahp] ${parts.join(", ")} across ${oversized.length} oversized session(s) before persisting`,
    );
    return {
        ...state,
        snapshots: snapshots.map((s) => replacements.get(s.resource) ?? s),
    };
}

/**
 * Trims the oldest retained actions until the serialized payload fits under
 * the total cap. Amortized O(retainedActions) via an average-bytes-per-action
 * estimate plus bounded refinement — never the O(n²) per-removal
 * re-serialization that previously pegged the extension host.
 */
export function trimRetained(
    state: AhpRuntimeExport,
    limits: AhpCompactionLimits,
): AhpRuntimeExport {
    const retainedActions = state.retainedActions;
    if (retainedActions.length === 0) return state;

    // Measure the immutable base (everything except retained actions) once,
    // then trim retained actions by count rather than by re-serializing the
    // whole state per removal.
    const baseBytes = byteLength({ ...state, retainedActions: [] as ActionEnvelope[] });
    const retainedBytes = byteLength(retainedActions);
    if (baseBytes + retainedBytes <= limits.maxBytes) return state;

    const avgPerAction = Math.max(1, Math.ceil(retainedBytes / retainedActions.length));
    const overage = baseBytes + retainedBytes - limits.maxBytes;
    const estimatedRemovals = Math.min(
        retainedActions.length,
        Math.ceil(overage / avgPerAction) + 1,
    );
    let trimmed = retainedActions.slice(estimatedRemovals);
    let iterations = 0;
    while (
        trimmed.length > 0 &&
        baseBytes + byteLength(trimmed) > limits.maxBytes &&
        iterations++ < 32
    ) {
        trimmed = trimmed.slice(Math.max(1, Math.ceil(trimmed.length / 10)));
    }
    while (
        trimmed.length > 1 &&
        baseBytes + byteLength(trimmed) < limits.maxBytes - avgPerAction &&
        iterations++ < 32
    ) {
        const reAdd = retainedActions.length - trimmed.length - 1;
        if (reAdd < 0) break;
        const candidate = retainedActions.slice(reAdd);
        if (baseBytes + byteLength(candidate) > limits.maxBytes) break;
        trimmed = candidate;
    }
    const removed = retainedActions.length - trimmed.length;
    if (removed <= 0) return state;
    const newFloor = trimmed[0]?.serverSeq ?? state.serverSeq;
    limits.onDiagnostic?.(
        `[ahp] trimmed ${removed} retained action(s) to stay under the ${limits.maxBytes}-byte persistence cap (new floor serverSeq=${newFloor})`,
    );
    return { ...state, retainedActions: trimmed };
}
