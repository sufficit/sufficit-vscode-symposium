import {
    fetchPendingWorkItems,
    fetchSessionTasks,
    markTaskDone,
    priorInBatch,
    rememberTaskBatch,
    rememberTaskCreated,
    rememberTaskDone,
} from "../../sync/tasks";
import type { ToolContext } from "./types";

const NAMES = new Set(["TaskCreate", "add_task", "list_tasks", "TaskUpdate", "task_complete"]);

export async function runTaskTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
): Promise<string | undefined> {
    if (!NAMES.has(name)) return undefined;
    if (name === "TaskCreate" || name === "add_task") return createTasks(args, ctx);
    if (name === "list_tasks") return listTasks(args, ctx);
    return completeTask(name, args, ctx);
}

async function createTasks(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!ctx.sessionId) return JSON.stringify({ error: "no current session" });
    if (!ctx.hub.configured()) return JSON.stringify({ error: "memory hub not configured" });
    const raw = Array.isArray(args.tasks) ? args.tasks : args.title ? [args.title] : [];
    const titles = raw
        .map((item) =>
            typeof item === "string"
                ? item
                : item && typeof item === "object"
                  ? (item as { title?: string }).title
                  : "",
        )
        .map((title) => String(title ?? "").trim())
        .filter(Boolean);
    if (!titles.length) {
        return JSON.stringify({ error: 'provide tasks: ["step 1", "step 2", …]' });
    }
    const userRequested = args.user_requested === true;
    const tags = `task-anchor,${userRequested ? "creator:user" : "creator:agent"}`;
    const ids: string[] = [];
    for (const title of titles) {
        const id = await ctx.hub.save({
            type: "task-anchor",
            title: title.slice(0, 80),
            summary: title,
            tags,
            sessionId: ctx.sessionId,
            privacyLevel: "internal",
        });
        if (id) {
            ids.push(id);
            rememberTaskCreated(ctx.sessionId, id, title);
        }
    }
    rememberTaskBatch(ctx.sessionId, ids);
    return JSON.stringify({
        ok: true,
        created: ids.length,
        ids,
        user_requested: userRequested,
        reminder: userRequested
            ? "USER-REQUESTED TASKS: When you finish, present justification and WAIT for user confirmation before calling task_complete."
            : "AGENT TASKS: Call task_complete(id) immediately after finishing each task - don't wait.",
    });
}

async function listTasks(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!ctx.sessionId) return JSON.stringify({ tasks: [] });
    const all = await fetchSessionTasks(ctx.hub, ctx.sessionId);
    const includeDone = args.all === true;
    const tasks = (includeDone ? all : all.filter((task) => !task.done)).map((task) => ({
        id: task.id,
        type: task.type,
        title: task.title,
        summary: task.summary,
        done: !!task.done,
        user_requested: String(task.tags || "")
            .split(",")
            .map((tag) => tag.trim())
            .includes("creator:user"),
    }));
    return JSON.stringify({ tasks, pendingOnly: !includeDone });
}

async function completeTask(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
): Promise<string> {
    const id = String(args.id ?? "");
    if (!id) {
        return JSON.stringify({
            error: "id is required — use the exact task UUID from the CURRENT reminder or list_tasks.",
        });
    }
    if (!ctx.hub.configured()) return JSON.stringify({ error: "memory hub not configured" });
    if (name === "TaskUpdate" && args.done === false) {
        return JSON.stringify({ ok: true, message: "task unchanged (done=false)" });
    }
    const summary = typeof args.summary === "string" ? args.summary : undefined;
    if (!(await markTaskDone(ctx.hub, id, summary))) {
        return JSON.stringify({ error: "save failed — check hub configuration" });
    }
    if (!ctx.sessionId) return JSON.stringify({ ok: true });
    rememberTaskDone(ctx.sessionId, id);
    const cascaded = await cascadePriorTasks(ctx, id, summary);
    return completionResult(ctx, [id, ...cascaded], cascaded);
}

async function cascadePriorTasks(
    ctx: ToolContext,
    id: string,
    summary?: string,
): Promise<string[]> {
    if (!ctx.sessionId) return [];
    const priorIds = priorInBatch(ctx.sessionId, id);
    if (!priorIds.length) return [];
    const observations = await ctx.hub.getByIds(priorIds).catch(() => []);
    const userRequested = new Set(
        observations
            .filter((item) =>
                (Array.isArray(item.tags) ? item.tags : String(item.tags ?? "").split(","))
                    .map((tag) => String(tag).trim())
                    .includes("creator:user"),
            )
            .map((item) => String(item.id)),
    );
    const completed: string[] = [];
    for (const priorId of priorIds) {
        if (!userRequested.has(priorId) && (await markTaskDone(ctx.hub, priorId, summary))) {
            rememberTaskDone(ctx.sessionId, priorId);
            completed.push(priorId);
        }
    }
    return completed;
}

async function completionResult(
    ctx: ToolContext,
    completed: string[],
    cascaded: string[],
): Promise<string> {
    const completedSet = new Set(completed);
    const remaining = (await fetchPendingWorkItems(ctx.hub, ctx.sessionId!)).filter(
        (task) => !completedSet.has(task.id),
    );
    const note = cascaded.length
        ? `Also auto-completed ${cascaded.length} earlier step(s) from the same numbered plan.`
        : undefined;
    if (!remaining.length) {
        return JSON.stringify({
            ok: true,
            completed,
            pending: [],
            message: "all tasks complete",
            allTasksComplete: true,
            cascaded,
            note,
        });
    }
    const [current, ...pending] = remaining;
    return JSON.stringify({
        ok: true,
        completed,
        current: { id: current.id, title: current.title },
        pending: pending.map((task) => ({ id: task.id, title: task.title })),
        cascaded,
        note,
    });
}
