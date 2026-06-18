import { TodoItem } from "./types";

/** Normalizes the many status spellings the CLIs use to our three states. */
function normStatus(s: unknown): TodoItem["status"] {
    const v = String(s ?? "").toLowerCase();
    if (v === "completed" || v === "done" || v === "complete" || v === "[x]" || v === "x") { return "completed"; }
    if (v === "in_progress" || v === "in-progress" || v === "active" || v === "doing" || v === "current" || v === "started") { return "in_progress"; }
    return "pending";
}

/** Maps one raw item ({content|step|text|title|task}, {status|state}) to a TodoItem. */
function toItem(raw: any): TodoItem | undefined {
    if (raw == null) { return undefined; }
    if (typeof raw === "string") { return { content: raw, status: "pending" }; }
    const content = raw.content ?? raw.step ?? raw.text ?? raw.title ?? raw.task ?? raw.name;
    if (typeof content !== "string" || !content.trim()) { return undefined; }
    const orderRaw = raw.order ?? raw.index ?? raw.number ?? raw.stepNumber ?? raw.step_number;
    const order = Number(orderRaw);
    return { content: content.trim(), status: normStatus(raw.status ?? raw.state), ...(Number.isFinite(order) && order > 0 ? { order } : {}) };
}

function toItems(arr: unknown): TodoItem[] | undefined {
    if (!Array.isArray(arr)) { return undefined; }
    const out = arr.map(toItem).filter((x): x is TodoItem => !!x);
    return out.length ? out : undefined;
}

/**
 * Recognizes a native plan/todo tool call across the different CLIs and returns
 * a normalized list — Claude `TodoWrite` ({todos}), Codex `update_plan`/
 * `todo_list` ({plan|steps|items}), and generic shapes. Returns undefined when
 * the tool isn't a plan/todo call.
 */
export function parseNativeTodos(toolName: string, input: unknown): TodoItem[] | undefined {
    const name = String(toolName || "").toLowerCase();
    const isTodoTool = name.includes("todo") || name.includes("plan");
    const o = (input ?? {}) as Record<string, unknown>;
    const fromKeys = toItems(o.todos) ?? toItems(o.plan) ?? toItems(o.steps) ?? toItems(o.items);
    if (fromKeys) { return fromKeys; }
    // A bare array input on a clearly-named todo tool.
    if (isTodoTool) { return toItems(input); }
    return undefined;
}

/**
 * Fallback for CLIs with no native todo tool: parse a fenced ```todo / ```plan
 * block of checkbox lines into todos.
 *   - [ ] pending
 *   - [-] in progress   (also [~], [/], [>])
 *   - [x] completed
 */
export function parseTodoFence(text: string): TodoItem[] | undefined {
    const m = String(text).match(/```(?:todo|plan|tasks)\s*\n([\s\S]*?)```/i);
    if (!m) { return undefined; }
    const items: TodoItem[] = [];
    for (const line of m[1].split("\n")) {
        // Supports both unordered and ordered task lines:
        //   - [ ] step
        //   1. [ ] step
        //   2) [-] step
        const li = line.match(/^\s*(?:(\d+)[.)]\s*)?(?:[-*]\s*)?\[([ xX\-~/>])\]\s*(.+?)\s*$/);
        if (!li) { continue; }
        const order = li[1] ? Number(li[1]) : undefined;
        const mark = li[2].toLowerCase();
        const status: TodoItem["status"] =
            mark === "x" ? "completed" : mark === " " ? "pending" : "in_progress";
        items.push({ content: li[3], status, ...(order ? { order } : {}) });
    }
    return items.length ? items : undefined;
}

/**
 * Instruction injected into sessions whose CLI has no native todo tool, so the
 * agent still surfaces a plan Symposium can render and check off.
 */
export const TODO_INJECTION =
    "When a task needs multiple steps, maintain an ordered plan as a fenced ```todo code block " +
    "and re-print the whole block whenever a step's state changes. Use one numbered line per step:\n" +
    "```todo\n1. [ ] first step\n2. [-] current step\n3. [x] completed step\n```\n" +
    "Keep the execution order stable and keep exactly one step `[-]` (in progress) at a time.";
