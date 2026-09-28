import type { TodoItem } from "../types";

type Task = { content: string; status: TodoItem["status"] };

function task(value: unknown): { id: string; item: Task } | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim()) return undefined;
    if (typeof raw.description !== "string" || !raw.description.trim()) return undefined;
    const status = String(raw.status ?? "pending").toLowerCase();
    return {
        id: raw.id,
        item: {
            content: raw.description.trim(),
            status:
                status === "done" ? "completed" : status === "active" ? "in_progress" : "pending",
        },
    };
}

/** Projects confirmed Genius tasks_* tool results into Symposium's plan snapshots. */
export class GeniusTaskTracker {
    private tasks = new Map<string, Task>();

    observe(toolName: string, result: string): TodoItem[] | undefined {
        if (!/^tasks_(?:create|update|list)$/i.test(toolName)) return undefined;
        let payload: unknown;
        try {
            payload = JSON.parse(result);
        } catch {
            return undefined;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
        const raw = payload as Record<string, unknown>;
        if (Array.isArray(raw.tasks)) {
            const next = new Map<string, Task>();
            for (const value of raw.tasks) {
                const parsed = task(value);
                if (!parsed) return undefined;
                next.set(parsed.id, parsed.item);
            }
            this.tasks = next;
        } else if (toolName.toLowerCase() === "tasks_create") {
            const parsed = task(payload);
            if (!parsed) return undefined;
            this.tasks.set(parsed.id, parsed.item);
        } else {
            return undefined;
        }
        return [...this.tasks.values()].map((item, index) => ({ ...item, order: index + 1 }));
    }
}
