/**
 * Cascade expansion shared by the single-session and bulk session actions.
 *
 * Archive/unarchive/delete cascade DOWN the subagent tree (parentId) — a
 * session's action never reaches back up to its parent or sideways to
 * siblings, only itself + whatever it spawned. A ROOT session (no parentId)
 * additionally drags its lineage-mates (edit/resend branches of the SAME
 * conversation, SessionInfo.lineageId) since those really are the one
 * conversation, just not descendants. Kept structural + import-free so both
 * the surface handlers and the tests can use it directly.
 */

/** Minimal session shape the cascade needs; SessionInfo satisfies it. */
export interface SessionCascadeTarget {
    sessionId: string;
    backend: string;
    parentId?: string;
    lineageId?: string;
}

/** Sessions an archive/unarchive/delete action on `selected` must reach. */
export function expandSessionCascadeTargets<T extends SessionCascadeTarget>(
    selected: T,
    sessions: T[],
): T[] {
    const byParent = new Map<string, T[]>();
    for (const s of sessions) {
        if (!s.parentId) {
            continue;
        }
        const siblings = byParent.get(s.parentId);
        if (siblings) {
            siblings.push(s);
        } else {
            byParent.set(s.parentId, [s]);
        }
    }
    const descendants: T[] = [];
    const walk = (id: string): void => {
        for (const child of byParent.get(id) ?? []) {
            descendants.push(child);
            walk(child.sessionId);
        }
    };
    walk(selected.sessionId);
    if (selected.parentId) {
        return [selected, ...descendants];
    }
    const lineageKey = selected.lineageId || selected.sessionId;
    const lineageMates = sessions.filter(
        (s) => !s.parentId && (s.lineageId || s.sessionId) === lineageKey,
    );
    const byId = new Map<string, T>();
    for (const s of [...lineageMates, selected, ...descendants]) {
        byId.set(s.sessionId, s);
    }
    return [...byId.values()];
}

/**
 * Expands a multi-select batch (bulk bar / project group menu): each selected
 * chat contributes its cascade, deduped by session id. Unknown ids (session
 * deleted meanwhile) are skipped.
 */
export function expandBulkCascadeTargets<T extends SessionCascadeTarget>(
    selected: SessionCascadeTarget[],
    sessions: T[],
): T[] {
    const byId = new Map<string, T>();
    for (const item of selected) {
        const info = sessions.find(
            (s) => s.sessionId === item.sessionId && s.backend === item.backend,
        );
        if (!info) {
            continue;
        }
        for (const target of expandSessionCascadeTargets(info, sessions)) {
            byId.set(target.sessionId, target);
        }
    }
    return [...byId.values()];
}
