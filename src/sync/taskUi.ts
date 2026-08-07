import type { TaskItem } from "./tasks";

export interface TaskStateOverride {
    done: boolean;
    at: number;
}

/** IDs explicitly reported by a successful task_complete/TaskUpdate result. */
export function completedTaskIds(result: unknown): string[] {
    if (!result || typeof result !== "object") {
        return [];
    }
    const ids = (result as { completed?: unknown }).completed;
    if (!Array.isArray(ids)) {
        return [];
    }
    return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/** Applies a known state without waiting for the memory search index. */
export function applyTaskState(items: TaskItem[], ids: string[], done: boolean): TaskItem[] {
    const wanted = new Set(ids);
    return items.map((item) => (wanted.has(item.id) ? { ...item, done } : item));
}

/**
 * Keeps a local state override while searchMemory still returns its stale
 * predecessor. The override is discarded as soon as search agrees, or after
 * the grace period so a failed/missing canonical update cannot stick forever.
 */
export function reconcileTaskStateOverrides(
    items: TaskItem[],
    overrides: Map<string, TaskStateOverride>,
    now: number,
    graceMs: number,
): TaskItem[] {
    return items.map((item) => {
        const override = overrides.get(item.id);
        if (!override) {
            return item;
        }
        if (!!item.done === override.done || now - override.at >= graceMs) {
            overrides.delete(item.id);
            return item;
        }
        return { ...item, done: override.done };
    });
}
