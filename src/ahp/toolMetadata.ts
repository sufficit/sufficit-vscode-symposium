import type { TodoItem } from "../adapters/types";

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Merges provider-neutral tool metadata without replacing Symposium fields. */
export function mergeToolMetadata(current: unknown, incoming: unknown): unknown {
    const base = record(current);
    const next = record(incoming);
    if (!Object.keys(next).length) return Object.keys(base).length ? base : undefined;
    return {
        ...base,
        ...next,
        symposium: { ...record(base.symposium), ...record(next.symposium) },
    };
}

/** Reads a normalized native plan snapshot carried through AHP tool metadata. */
export function toolTodosFromMetadata(meta: unknown): TodoItem[] | undefined {
    const value = record(record(meta).symposium).todos;
    if (!Array.isArray(value)) return undefined;
    const todos: TodoItem[] = [];
    for (const candidate of value) {
        const item = record(candidate);
        const content = typeof item.content === "string" ? item.content : "";
        const status = item.status;
        if (
            !content ||
            (status !== "pending" && status !== "in_progress" && status !== "completed")
        ) {
            return undefined;
        }
        todos.push({
            content,
            status,
            ...(typeof item.order === "number" ? { order: item.order } : {}),
        });
    }
    return todos;
}
