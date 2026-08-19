import type { TodoItem } from "../adapters/types";

/** Reads a normalized task snapshot from a persisted or live render message. */
export function todoSnapshotFromRenderMessage(message: unknown): TodoItem[] | undefined {
    const value = message as Record<string, unknown>;
    const event = value?.event as { todos?: unknown } | undefined;
    return validSnapshot(value?.todos ?? event?.todos);
}

/** Returns the newest valid task snapshot in a history/render sequence. */
export function latestTodoSnapshot(messages: readonly unknown[]): TodoItem[] | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const snapshot = todoSnapshotFromRenderMessage(messages[i]);
        if (snapshot !== undefined) return snapshot;
    }
    return undefined;
}

function validSnapshot(value: unknown): TodoItem[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.every((item) => {
        const todo = item as { content?: unknown; status?: unknown };
        return (
            typeof todo?.content === "string" &&
            todo.content.trim().length > 0 &&
            /^(pending|in_progress|completed)$/u.test(String(todo.status))
        );
    })
        ? (value as TodoItem[])
        : undefined;
}
