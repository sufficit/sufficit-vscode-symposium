import { TodoItem } from "../types";

type TaskStatus = TodoItem["status"];
type TaskKind = "create" | "update" | "list" | "get";

interface TrackedTask {
    content: string;
    status: TaskStatus;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function nativeTaskKind(name: string): TaskKind | undefined {
    switch (String(name).toLowerCase()) {
        case "taskcreate": return "create";
        case "taskupdate": return "update";
        case "tasklist": return "list";
        case "taskget": return "get";
        default: return undefined;
    }
}

function taskStatus(value: unknown): TaskStatus {
    switch (String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")) {
        case "completed": case "complete": case "done": return "completed";
        case "in_progress": case "inprogress": case "active": return "in_progress";
        default: return "pending";
    }
}

function taskContent(value: Record<string, unknown>): string | undefined {
    for (const key of ["subject", "content", "title", "description", "activeForm"]) {
        const text = value[key];
        if (typeof text === "string" && text.trim()) { return text.trim(); }
    }
    return undefined;
}

/**
 * Reconciles Claude Code's native TaskCreate/TaskUpdate protocol to the full
 * todo snapshot expected by the Symposium plan panel. Claude 2.1.210 replaced
 * its earlier TodoWrite payload with individual, server-assigned task records.
 * Keeping this state local to the Claude adapter leaves every other adapter's
 * stateless native-todo parser unchanged.
 */
export class ClaudeTaskTracker {
    private tasks = new Map<string, TrackedTask>();
    private readonly pendingCreates = new Map<string, string>();
    private readonly toolKinds = new Map<string, TaskKind>();
    private pendingNumber = 0;

    /** Records a Claude native task call and returns the current full snapshot when it changed. */
    observeToolUse(toolName: string, input: unknown, toolId?: string): TodoItem[] | undefined {
        const kind = nativeTaskKind(toolName);
        if (!kind) { return undefined; }
        if (toolId) { this.toolKinds.set(toolId, kind); }
        const payload = record(input) ?? {};

        if (kind === "create") {
            const content = taskContent(payload);
            if (!content) { return undefined; }
            const key = `pending:${toolId || ++this.pendingNumber}`;
            this.tasks.set(key, { content, status: taskStatus(payload.status) });
            if (toolId) { this.pendingCreates.set(toolId, key); }
            return this.snapshot();
        }

        if (kind !== "update") { return undefined; }
        const id = typeof payload.taskId === "string" ? payload.taskId : "";
        const existing = id ? this.tasks.get(id) : undefined;
        if (!existing) { return undefined; }
        if (String(payload.status ?? "").trim().toLowerCase() === "deleted") {
            this.tasks.delete(id);
        } else {
            this.tasks.set(id, {
                content: taskContent(payload) ?? existing.content,
                status: taskStatus(payload.status),
            });
        }
        return this.snapshot();
    }

    /** Associates TaskCreate's server-assigned id and consumes authoritative TaskList/Get results. */
    observeToolResult(toolId: string | undefined, result: unknown): TodoItem[] | undefined {
        if (!toolId) { return undefined; }
        const kind = this.toolKinds.get(toolId);
        this.toolKinds.delete(toolId);
        if (!kind) { return undefined; }
        const payload = record(result) ?? {};

        if (kind === "list" && Array.isArray(payload.tasks)) {
            const next = new Map<string, TrackedTask>();
            for (const rawTask of payload.tasks) {
                const task = record(rawTask);
                const id = typeof task?.id === "string" ? task.id : "";
                const content = task ? taskContent(task) : undefined;
                if (task && id && content && String(task.status ?? "").toLowerCase() !== "deleted") {
                    next.set(id, { content, status: taskStatus(task.status) });
                }
            }
            this.tasks = next;
            return this.snapshot();
        }

        const task = record(payload.task);
        const id = typeof task?.id === "string" ? task.id : "";
        const pendingKey = this.pendingCreates.get(toolId);
        this.pendingCreates.delete(toolId);
        if (!task || !id) { return undefined; }

        const prior = pendingKey ? this.tasks.get(pendingKey) : this.tasks.get(id);
        const content = taskContent(task) ?? prior?.content;
        if (!content) { return undefined; }
        if (pendingKey) { this.tasks.delete(pendingKey); }
        if (String(task.status ?? "").toLowerCase() === "deleted") { this.tasks.delete(id); }
        else { this.tasks.set(id, { content, status: taskStatus(task.status ?? prior?.status) }); }
        return this.snapshot();
    }

    snapshot(): TodoItem[] {
        return [...this.tasks.values()].map((task, index) => ({ ...task, order: index + 1 }));
    }
}
