import { TodoItem } from "./types";

/** Normalizes the many status spellings the CLIs use to our three states. */
function normStatus(s: unknown): TodoItem["status"] {
    const v = String(s ?? "").toLowerCase();
    if (v === "completed" || v === "done" || v === "complete" || v === "[x]" || v === "x") { return "completed"; }
    if (v === "in_progress" || v === "in-progress" || v === "active" || v === "doing" || v === "current" || v === "started") { return "in_progress"; }
    return "pending";
}

/** Maps one raw item ({content|step|text|title|task}, {status|state}) to a TodoItem. */
function toItem(raw: string | Record<string, unknown>): TodoItem | undefined {
    if (raw == null) { return undefined; }
    if (typeof raw === "string") { return { content: raw, status: "pending" }; }
    const obj = raw as Record<string, unknown>;
    const content = obj.content ?? obj.step ?? obj.text ?? obj.title ?? obj.task ?? obj.name;
    if (typeof content !== "string" || !content.trim()) { return undefined; }
    const orderRaw = obj.order ?? obj.index ?? obj.number ?? obj.stepNumber ?? obj.step_number;
    const order = Number(orderRaw);
    // `codex exec --json` deliberately flattens update_plan's three states to
    // todo_list items shaped as { text, completed }. Preserve completed steps
    // here; the first remaining open item is promoted to in_progress below.
    const status = typeof obj.completed === "boolean"
        ? (obj.completed ? "completed" : "pending")
        : normStatus(obj.status ?? obj.state);
    return { content: String(content).trim(), status, ...(Number.isFinite(order) && order > 0 ? { order } : {}) };
}

function toItems(arr: unknown): TodoItem[] | undefined {
    if (!Array.isArray(arr)) { return undefined; }
    const out = arr.map(toItem).filter((x): x is TodoItem => !!x);
    return out.length ? out : undefined;
}

/**
 * Codex's public JSONL todo_list loses the explicit in_progress value, but the
 * plan contract keeps work ordered: completed prefix, then current, then
 * pending suffix. Recover the current marker as the first open item so both
 * the panel and the next-turn reminder advance with the agent.
 */
function recoverCodexTodoListCurrent(items: TodoItem[]): TodoItem[] {
    if (items.some((item) => item.status === "in_progress")) { return items; }
    const current = items.findIndex((item) => item.status !== "completed");
    return current < 0
        ? items
        : items.map((item, index) => index === current ? { ...item, status: "in_progress" } : item);
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "string" || !value.trim()) { return undefined; }
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
    } catch {
        return undefined;
    }
}

/**
 * From `text[openIdx]` (an opening `(`/`[`/`{`), returns the text strictly
 * between it and its matching close, skipping quoted-string contents (with
 * `\"` escapes) so a bracket char inside a step/status string can't throw the
 * balance count off. Returns undefined if unbalanced.
 */
function extractBalanced(text: string, openIdx: number): string | undefined {
    const open = text[openIdx];
    const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : undefined;
    if (!close) { return undefined; }
    let depth = 0;
    let inString: string | null = null;
    for (let i = openIdx; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") { i++; continue; }
            if (ch === inString) { inString = null; }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
        if (ch === open) { depth++; }
        else if (ch === close) {
            depth--;
            if (depth === 0) { return text.slice(openIdx + 1, i); }
        }
    }
    return undefined;
}

/**
 * Splits the top-level `{...}` object chunks within `text` (e.g. an array
 * literal's body), quote-aware like extractBalanced, so each array element
 * comes back as its own self-contained chunk instead of one giant blob.
 */
function splitTopLevelObjects(text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = -1;
    let inString: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") { i++; continue; }
            if (ch === inString) { inString = null; }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
        if (ch === "{" || ch === "[" || ch === "(") {
            if (ch === "{" && depth === 0) { start = i; }
            depth++;
        } else if (ch === "}" || ch === "]" || ch === ")") {
            depth--;
            if (ch === "}" && depth === 0 && start >= 0) {
                out.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return out;
}

/** First `key: "value"` match among the given unquoted-JS-identifier key names. */
function matchQuotedField(objText: string, keys: string[]): string | undefined {
    for (const key of keys) {
        const m = objText.match(new RegExp(`\\b${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
        if (m) { return m[1].replace(/\\(.)/g, "$1"); }
    }
    return undefined;
}

/**
 * Codex's `custom_tool_call` (name "exec") sandboxes a whole small JS program
 * as source TEXT in `input`, e.g.
 *   const p = await tools.update_plan({plan:[{step:"...",status:"pending"}]});
 *   const r = await tools.exec_command({...});
 * — not a structured function_call/arguments JSON envelope, so JSON.parse on
 * it (todoPayload's normal path) always fails and the call goes unrecognized.
 * Find the update_plan(...) call, pull its argument text out (balanced, never
 * eval'd), locate the steps array inside it, and read each element's
 * step/status pair via plain regex (the object literal has unquoted JS keys,
 * not JSON).
 */
function parseExecUpdatePlanCall(source: string): TodoItem[] | undefined {
    const marker = "tools.update_plan(";
    const callIdx = source.indexOf(marker);
    if (callIdx < 0) { return undefined; }
    const argsText = extractBalanced(source, callIdx + marker.length - 1);
    if (argsText === undefined) { return undefined; }
    const arrayStart = argsText.indexOf("[");
    if (arrayStart < 0) { return undefined; }
    const arrayText = extractBalanced(argsText, arrayStart);
    if (arrayText === undefined) { return undefined; }
    const items: TodoItem[] = [];
    for (const objText of splitTopLevelObjects(arrayText)) {
        const content = matchQuotedField(objText, ["step", "content", "title", "text"]);
        if (!content) { continue; }
        items.push({ content, status: normStatus(matchQuotedField(objText, ["status", "state"])) });
    }
    return items.length ? items : undefined;
}

function todoToolName(toolName: string, input: unknown): string {
    const obj = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    const inner = typeof obj.name === "string" ? obj.name : "";
    return String(inner || toolName || "").toLowerCase();
}

function todoPayload(input: unknown): unknown {
    if (typeof input !== "object" || input === null) { return input; }
    const obj = input as Record<string, unknown>;
    return parseJsonObject(obj.arguments)
        ?? parseJsonObject(obj.input)
        ?? (typeof obj.arguments === "object" && obj.arguments !== null ? obj.arguments : undefined)
        ?? (typeof obj.input === "object" && obj.input !== null ? obj.input : undefined)
        ?? input;
}

/**
 * Recognizes a native plan/todo tool call across the different CLIs and returns
 * a normalized list — Claude `TodoWrite` ({todos}), Codex `update_plan`/
 * `todo_list` ({plan|steps|items}), and generic shapes. Returns undefined when
 * the tool isn't a plan/todo call.
 */
export function parseNativeTodos(toolName: string, input: unknown): TodoItem[] | undefined {
    // Codex exec-sandboxed custom_tool_call: check this shape first, since its
    // `input` is JS source text that JSON.parse (todoPayload's normal path)
    // can never make sense of.
    if (typeof input === "object" && input !== null) {
        const raw = (input as Record<string, unknown>).input;
        if (typeof raw === "string" && raw.includes("tools.update_plan(")) {
            const fromExec = parseExecUpdatePlanCall(raw);
            if (fromExec) { return fromExec; }
        }
    }
    const name = todoToolName(toolName, input);
    const isTodoTool = name.includes("todo") || name.includes("plan");
    const payload = todoPayload(input);
    const o = (payload ?? {}) as Record<string, unknown>;
    const fromKeys = toItems(o.todos) ?? toItems(o.plan) ?? toItems(o.steps) ?? toItems(o.items);
    if (fromKeys) {
        return name.includes("todo_list") ? recoverCodexTodoListCurrent(fromKeys) : fromKeys;
    }
    // A bare array input on a clearly-named todo tool.
    if (isTodoTool) { return toItems(payload); }
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
 * Per-turn reminder of the current plan/todo state for native/fence tracking
 * (Claude, Codex, Copilot, OpenAI-fence) — the same idea as the Hub tasks
 * reminder (controllerHubState.ts's pendingTasksSummary), but sourced from the
 * locally-parsed TodoWrite/update_plan/fence state instead of Sufficit-memory
 * task records, so the agent is told what's still open on every message, not
 * just the turn that first stated the plan.
 */
export function todosSummary(todos: TodoItem[]): string | undefined {
    const open = todos.filter((t) => t.status !== "completed");
    if (open.length === 0) { return undefined; }
    const current = open.find((t) => t.status === "in_progress") || open[0];
    const upNext = open.filter((t) => t !== current).map((t) => `- ${t.content}`).join("\n");
    return (
        "[PLAN — current step marked below, still open from your own tracked plan. " +
        "The moment you finish CURRENT (or any other step's state changes), re-emit the FULL plan via your " +
        "native plan/todo tool with that step marked completed — do not wait until everything is done to " +
        "report progress in one batch; the panel only shows what you last emitted.]\n" +
        `→ CURRENT: ${current.content}` +
        (upNext ? `\nUp next:\n${upNext}` : "")
    );
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
