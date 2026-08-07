// Plan/tasks/guardrails/queued/changed-files panels + working set.
import { saved, saveState } from "./vscode";
import {
    planEl,
    tasksEl,
    guardrailsEl,
    queuedEl,
    changedFiles,
    panelBody,
    panelTabs,
    attachedPanel,
    chips,
    composerEl,
} from "./dom";
import { svgIcon } from "./icons";
import { endMessageStream, endMessageToolGroup } from "./messageBridge";
import { registerPanelBridge } from "./panelBridge";
import { lastTaskItems } from "./taskPanel";
export { renderTasks } from "./taskPanel";
import { changedItems, setChangedItems } from "./changedFilesPanel";
export { renderChangedFiles, setChangedItems } from "./changedFilesPanel";
import type { TodoItem } from "../../adapters/types";

const planBySession: Record<string, TodoItem[]> = {};
const todoDismissals = saved.todoDismissals || {}; // sessionId -> removed todo ids
function todoId(t: TodoItem): string {
    return String(t?.content || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}
function dismissedSet(key = wsKey): Set<string> {
    return new Set(todoDismissals[key] || []);
}
function persistDismissed(set: Set<string>): void {
    todoDismissals[wsKey] = [...set].filter(Boolean);
    saveState({ todoDismissals });
}
function visibleTodos(todos: TodoItem[], key = wsKey): TodoItem[] {
    const removed = dismissedSet(key);
    return (todos || [])
        .map((t) => ({ ...t, removed: removed.has(todoId(t)) }))
        .filter((t) => !t.removed);
}
export function todoMark(status: TodoItem["status"]): SVGSVGElement {
    if (status === "completed") return svgIcon("check");
    if (status === "in_progress") return svgIcon("circleHalf");
    return svgIcon("circleEmpty");
}
export function clearTodos(which: "done" | "all"): void {
    const todos = planBySession[wsKey] || [];
    const removed = dismissedSet();
    if (which === "done") {
        for (const t of todos) {
            if (t.status === "completed") {
                removed.add(todoId(t));
            }
        }
    } else {
        for (const t of todos) {
            removed.add(todoId(t));
        }
    }
    persistDismissed(removed);
    planBySession[wsKey] = visibleTodos(todos);
    renderPlan();
}
// Ids that just turned "completed" and are fading out (~5s), and the ids
// already-completed as of the last render — both keyed per session so a
// background session's timers can't clobber the one currently on screen.
// Mirrors the Hub Tasks panel's taskCompleting/taskPrevDone pattern.
const planPrevDone: Record<string, Set<string>> = {};
const planCompleting: Record<string, Set<string>> = {};
function dismissAll(key: string, todos: TodoItem[]): void {
    const removed = new Set(todoDismissals[key] || []);
    for (const t of todos) {
        removed.add(todoId(t));
    }
    todoDismissals[key] = [...removed].filter(Boolean);
    saveState({ todoDismissals });
    planBySession[key] = [];
    if (key === wsKey) {
        renderPlan();
    }
}
// A TodoWrite carries the full current list; just store it for this session.
export function renderTodos(todos: TodoItem[]): void {
    const key = wsKey;
    const visible = visibleTodos(todos);
    const prevDone = planPrevDone[key] || (planPrevDone[key] = new Set());
    const completing = planCompleting[key] || (planCompleting[key] = new Set());
    // A step that just became completed lingers with a completion animation
    // (~5s, matches the Hub Tasks panel) before it's auto-dismissed. Once
    // every step is completed and settled, the whole card auto-clears —
    // finished work shouldn't sit there forever waiting for a manual "Clear
    // all" click.
    for (const t of visible) {
        const id = todoId(t);
        if (t.status === "completed" && !prevDone.has(id) && !completing.has(id)) {
            completing.add(id);
            setTimeout(() => {
                completing.delete(id);
                const cur = planBySession[key] || [];
                const latest = cur.find((x) => todoId(x) === id);
                // The agent may have revised the item back to open while the
                // completion animation was running. Never dismiss that newer
                // state just because an older timer fired.
                if (!latest || latest.status !== "completed") {
                    if (key === wsKey) {
                        renderPlan();
                    }
                    return;
                }
                if (cur.every((x) => x.status === "completed") && completing.size === 0) {
                    dismissAll(key, cur);
                    return;
                }
                // A partially completed plan should advance visually as work
                // progresses: after the short acknowledgement animation, drop
                // this completed row while keeping current/pending rows.
                const removed = new Set(todoDismissals[key] || []);
                removed.add(id);
                todoDismissals[key] = [...removed].filter(Boolean);
                saveState({ todoDismissals });
                planBySession[key] = visibleTodos(cur, key);
                if (key === wsKey) {
                    renderPlan();
                }
            }, 5200);
        }
    }
    prevDone.clear();
    for (const t of visible) {
        if (t.status === "completed") {
            prevDone.add(todoId(t));
        }
    }
    planBySession[key] = visible;
    renderPlan();
}
export function renderPlan(): void {
    const todos = planBySession[wsKey] || [];
    planEl.textContent = "";
    if (!todos.length) {
        planEl.classList.remove("has");
        refreshPanels();
        return;
    }
    planEl.classList.add("has");
    if (!activePanel) {
        activePanel = "plan";
    }
    const done = todos.filter((t) => t.status === "completed").length;
    const current =
        todos.find((t) => t.status === "in_progress") || todos.find((t) => t.status === "pending");
    const completing = planCompleting[wsKey] || new Set();

    // Bordered card wrapper (matches the chat-todo-list-widget look). Header
    // is a static label — same treatment as the Hub Tasks panel — so the two
    // read as one consistent component; "current" is shown in the list itself
    // (the highlighted in-progress row) instead of duplicated into the header.
    const card = document.createElement("div");
    card.className = "plcard";
    const head = document.createElement("div");
    head.className = "plhead";
    const chev = svgIcon("chevron");
    chev.classList.add("plchev");
    head.appendChild(svgIcon("list"));
    const ttl = document.createElement("span");
    ttl.className = "pltitle";
    ttl.textContent = "Tasks";
    ttl.title = current ? "Current: " + current.content : "Tasks";
    const cnt = document.createElement("span");
    cnt.className = "plcount";
    cnt.textContent = done + "/" + todos.length;
    head.appendChild(ttl);
    head.appendChild(cnt);
    head.appendChild(chev);
    head.addEventListener("click", () => planEl.classList.toggle("collapsed"));
    const actions = document.createElement("div");
    actions.className = "plactions";
    const mkAction = (
        icon: string,
        label: string,
        title: string,
        cls: string,
        disabled: boolean,
        fn: () => void,
    ): HTMLButtonElement => {
        const b = document.createElement("button");
        b.className = "plaction " + (cls || "");
        b.title = title;
        b.disabled = !!disabled;
        b.appendChild(svgIcon(icon));
        b.appendChild(document.createTextNode(label));
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!b.disabled) {
                fn();
            }
        });
        return b;
    };
    actions.appendChild(
        mkAction("check", "Clear completed", "Clear completed tasks", "", done === 0, () =>
            clearTodos("done"),
        ),
    );
    actions.appendChild(
        mkAction("trash", "Clear all", "Clear all tasks", "danger", false, () => clearTodos("all")),
    );
    const list = document.createElement("div");
    list.className = "pllist";
    for (const t of todos) {
        const item = document.createElement("div");
        item.className =
            "todoitem" +
            (t.status === "completed" ? " done" : t.status === "in_progress" ? " active" : "") +
            (completing.has(todoId(t)) ? " completing" : "");
        const ord = document.createElement("span");
        ord.className = "torder";
        ord.textContent = String(t.order || todos.indexOf(t) + 1) + ".";
        const mk = document.createElement("span");
        mk.className = "tmark" + (t.status === "pending" ? " pending" : "");
        mk.appendChild(todoMark(t.status));
        const c = document.createElement("span");
        c.className = "tcontent";
        c.textContent = t.content;
        item.appendChild(ord);
        item.appendChild(mk);
        item.appendChild(c);
        list.appendChild(item);
    }
    card.appendChild(head);
    card.appendChild(actions);
    card.appendChild(list);
    planEl.appendChild(card);
    refreshPanels();
}

// Guardrails + queued-messages panels moved to panelsExtras.ts (check:size).
export { renderGuardrails, renderQueued } from "./panelsExtras";
import { lastGuardrailItems } from "./panelsExtras";

// ---- changed-files working set (above the composer) ----
// The edited-files list is OWNED BY THE CONTROLLER (extension side) and
// pushed via {type:"changed-files"}, so it survives view switches and keeps
// approvals resolved. The plan, below, is still session-keyed in the webview.
const NEW_KEY = "__new__"; // placeholder until a session id arrives
let wsKey = NEW_KEY;
// Switch the active PLAN to a session id (changed-files comes from controller).
export function startWorkingSet(sessionId: string): void {
    wsKey = sessionId || NEW_KEY;
    delete planBySession[wsKey];
    renderPlan();
}
export function bindWorkingSet(sessionId: string): void {
    if (!sessionId || wsKey === sessionId) {
        return;
    }
    if (wsKey === NEW_KEY && planBySession[NEW_KEY]) {
        planBySession[sessionId] = planBySession[NEW_KEY];
        delete planBySession[NEW_KEY];
    }
    wsKey = sessionId;
    renderPlan();
}
// ---- panel tabs: guardrails / tasks / edited-files collapse into an icon
// strip above the composer; click an icon to open that panel (one at a time).
type PanelKey = "plan" | "guardrails" | "tasks" | "changed" | "attached";
interface PanelDefinition {
    key: PanelKey;
    icon: string;
    el: HTMLElement;
    title: string;
    count: number;
    badge: string;
    color: string;
}
let activePanel: PanelKey | null = null;
// Soft, theme-aware accent per tag type (VS Code chart colors) so each is
// distinguishable at a glance; dimmed by the .ptab opacity so they stay gentle.
export function panelDefs(): PanelDefinition[] {
    const planTodos = planBySession[wsKey] || [];
    const planDone = planTodos.filter((t) => t.status === "completed").length;
    const pending = lastTaskItems.filter((t) => !t.done).length;
    return [
        {
            key: "attached",
            icon: "file",
            el: attachedPanel,
            title: "Attached to context",
            count: chips.children.length,
            badge: String(chips.children.length),
            color: "var(--vscode-charts-orange, #d9a45b)",
        },
        {
            key: "plan",
            icon: "list",
            el: planEl,
            title: "Tasks",
            count: planTodos.length,
            badge: planDone + "/" + planTodos.length,
            color: "var(--vscode-charts-blue, #4e9bd6)",
        },
        {
            key: "guardrails",
            icon: "shield",
            el: guardrailsEl,
            title: "Guardrails",
            count: lastGuardrailItems.length,
            badge: String(lastGuardrailItems.length),
            color: "var(--vscode-charts-purple, #b180d7)",
        },
        {
            key: "tasks",
            icon: "list",
            el: tasksEl,
            title: "Memory tasks",
            count: lastTaskItems.length,
            badge: pending + "/" + lastTaskItems.length,
            color: "var(--vscode-charts-cyan, #4ec9b0)",
        },
        {
            key: "changed",
            icon: "diff",
            el: changedFiles,
            title: "Edited files",
            count: changedItems.length,
            badge: String(changedItems.length),
            color: "var(--vscode-charts-green, #89c374)",
        },
    ];
}
export function refreshPanels() {
    const defs = panelDefs();
    const shown = defs.filter((d) => d.count > 0);
    if (activePanel && !shown.some((d) => d.key === activePanel)) {
        activePanel = null;
    }
    // Panels always start CLOSED: never auto-open on render or when new content
    // appears (e.g. edited files after a message). The user opens one by clicking
    // its tab. Only an explicit click sets activePanel.
    panelTabs.textContent = "";
    for (const d of shown) {
        const b = document.createElement("button");
        b.className = "ptab" + (activePanel === d.key ? " active" : "");
        b.title = d.title;
        b.setAttribute("aria-label", d.title + " (" + d.count + ")");
        b.style.color = d.color;
        b.appendChild(svgIcon(d.icon));
        const badge = document.createElement("span");
        badge.className = "ptBadge";
        badge.textContent = d.badge;
        b.appendChild(badge);
        b.addEventListener("click", () => {
            activePanel = activePanel === d.key ? null : d.key;
            refreshPanels();
        });
        panelTabs.appendChild(b);
    }
    panelTabs.classList.toggle("has", shown.length > 0);
    for (const d of defs) {
        d.el.style.display = d.count > 0 && activePanel === d.key ? "" : "none";
    }
    const bodyVisible = activePanel != null && shown.some((d) => d.key === activePanel);
    panelBody.classList.toggle("has", bodyVisible);
    // Dock the open panel flush onto the composer (no gap, connected borders).
    composerEl.classList.toggle("panelsAttached", bodyVisible);
}
export function resetWorkingState() {
    // clear arrives before meta; the controller re-sends changed-files on
    // attach, so just hide the panels here.
    endMessageToolGroup();
    endMessageStream();
    setChangedItems([]);
    changedFiles.textContent = "";
    changedFiles.classList.remove("has");
    planEl.textContent = "";
    planEl.classList.remove("has");
    queuedEl.textContent = "";
    queuedEl.classList.remove("has");
    refreshPanels();
}

registerPanelBridge({ refresh: refreshPanels, renderTodos, todoMark });
