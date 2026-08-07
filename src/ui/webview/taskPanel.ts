import { postMessage } from "./vscode";
import { tasksEl } from "./dom";
import { svgIcon } from "./icons";
import { relWhen } from "./format";
import { refreshPanelLayout } from "./panelBridge";
import type { TaskItem } from "./types";

// ---- Tasks panel (Sufficit-memory task list, local mirror) ----
let tasksShowAll = false; // header filter: pending-only (default) vs all
export let lastTaskItems: TaskItem[] = [];
let lastTaskProject = "";
const taskPrevDone = new Set(); // done ids seen on the previous render
const taskCompleting = new Set(); // done ids currently animating out (~5s)
export function renderTasks(items: TaskItem[], project: string): void {
    lastTaskItems = items || [];
    lastTaskProject = project || "";
    tasksEl.textContent = "";
    if (!items || !items.length) {
        tasksEl.classList.remove("has");
        taskPrevDone.clear();
        refreshPanelLayout();
        return;
    }
    // A task that just became done lingers with a completion animation for
    // ~5s (time to notice), then drops from the pending view on re-render.
    for (const it of items) {
        if (it.done && !taskPrevDone.has(it.id)) {
            taskCompleting.add(it.id);
            setTimeout(() => {
                taskCompleting.delete(it.id);
                renderTasks(lastTaskItems, lastTaskProject);
            }, 5200);
        }
    }
    taskPrevDone.clear();
    for (const it of items) {
        if (it.done) {
            taskPrevDone.add(it.id);
        }
    }

    const pending = items.filter((it) => !it.done);
    const visible = tasksShowAll
        ? items
        : items.filter((it) => !it.done || taskCompleting.has(it.id));

    const card = document.createElement("div");
    card.className = "tkcard";
    const head = document.createElement("div");
    head.className = "tkhead";
    head.appendChild(svgIcon("list"));
    const ttl = document.createElement("span");
    ttl.className = "tktitle";
    ttl.textContent = "Tasks";
    ttl.title = "Sufficit memory tasks for this session" + (project ? " — session " + project : "");
    const cnt = document.createElement("span");
    cnt.className = "tkcount";
    cnt.textContent = pending.length + "/" + items.length;
    cnt.title = pending.length + " pending of " + items.length + " total";
    const filterBtn = document.createElement("button");
    filterBtn.className = "tkbtn tkfilter";
    filterBtn.textContent = tasksShowAll ? "All" : "Pending";
    filterBtn.title = "Show all tasks or only pending";
    filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        tasksShowAll = !tasksShowAll;
        renderTasks(lastTaskItems, lastTaskProject);
    });
    const refresh = document.createElement("button");
    refresh.className = "tkbtn";
    refresh.title = "Refresh from memory";
    refresh.appendChild(svgIcon("refresh"));
    refresh.addEventListener("click", (e) => {
        e.stopPropagation();
        postMessage({ type: "refresh-tasks" });
    });
    head.appendChild(ttl);
    head.appendChild(cnt);
    head.appendChild(filterBtn);
    head.appendChild(refresh);
    card.appendChild(head);
    const list = document.createElement("div");
    list.className = "tklist";
    for (const it of visible) {
        const row = document.createElement("div");
        row.className =
            "tkitem" + (it.done ? " done" : "") + (taskCompleting.has(it.id) ? " completing" : "");
        const isAnchor = String(it.type || "").indexOf("anchor") >= 0;
        // Clickable status: ○ pending / ✓ done. The USER can toggle it
        // (no agent needed) — clearer than the old "CHECK" badge.
        const status = document.createElement("button");
        status.className = "tkstatus" + (it.done ? " done" : "");
        status.title = it.done ? "Completed — click to reopen" : "Pending — click to mark done";
        status.appendChild(svgIcon(it.done ? "check" : "circleEmpty"));
        status.addEventListener("click", (e) => {
            e.stopPropagation();
            postMessage({ type: "task-set-done", id: it.id, done: !it.done });
        });
        if (isAnchor) {
            row.classList.add("anchor");
        }
        const txt = document.createElement("span");
        txt.className = "tktext";
        txt.textContent = it.title || it.summary || "(untitled)";
        txt.title = (it.title ? it.title + "\n\n" : "") + (it.summary || "");
        const when = document.createElement("span");
        when.className = "tkwhen";
        when.textContent = relWhen(it.ts);
        row.appendChild(status);
        row.appendChild(txt);
        row.appendChild(when);
        list.appendChild(row);
    }
    card.appendChild(list);
    tasksEl.appendChild(card);
    tasksEl.classList.add("has");
    refreshPanelLayout();
}
