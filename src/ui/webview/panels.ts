// Plan/tasks/guardrails/queued/changed-files panels + working set.
import { vscode } from "./vscode";
import { planEl, tasksEl, guardrailsEl, queuedEl, changedFiles, panelBody, panelTabs, attachedPanel, chips } from "./dom";
import { activeSessionId, setQueued } from "./state";
import { setStatus } from "./status";
import { svgIcon, fileIcon } from "./icons";
import { relWhen } from "./format";
import { nearBottom } from "./scroll";
import { endStream, endToolGroup } from "./messages";
import { renderChips } from "./composer";

const planBySession = {};   // sessionId -> todos[]
export function todoMark(status) {
    if (status === "completed") return svgIcon("check");
    if (status === "in_progress") return svgIcon("circleHalf");
    return svgIcon("circleEmpty");
}
export function clearTodos(which) {
    const todos = planBySession[wsKey] || [];
    if (which === "done") {
        planBySession[wsKey] = todos.filter((t) => t.status !== "completed");
    } else {
        planBySession[wsKey] = [];
    }
    renderPlan();
}
// A TodoWrite carries the full current list; just store it for this session.
export function renderTodos(todos) {
    planBySession[wsKey] = todos || [];
    renderPlan();
}
export function renderPlan() {
    const todos = planBySession[wsKey] || [];
    planEl.textContent = "";
    if (!todos.length) { planEl.classList.remove("has"); return; }
    planEl.classList.add("has");
    const done = todos.filter((t) => t.status === "completed").length;
    // Header summary mirrors Copilot Chat: show the task in progress (or the
    // next pending one, or a generic label once everything is done).
    const current = todos.find((t) => t.status === "in_progress")
        || todos.find((t) => t.status === "pending");
    const summary = current ? current.content : "Todos";

    // Bordered card wrapper (matches the chat-todo-list-widget look).
    const card = document.createElement("div"); card.className = "plcard";
    const head = document.createElement("div"); head.className = "plhead";
    const chev = svgIcon("chevron"); chev.classList.add("plchev");
    head.appendChild(svgIcon("list"));
    const ttl = document.createElement("span"); ttl.className = "pltitle";
    ttl.textContent = summary; ttl.title = summary;
    const cnt = document.createElement("span"); cnt.className = "plcount"; cnt.textContent = done + "/" + todos.length;
    head.appendChild(ttl); head.appendChild(cnt); head.appendChild(chev);
    head.addEventListener("click", () => planEl.classList.toggle("collapsed"));
    const actions = document.createElement("div"); actions.className = "plactions";
    const mkAction = (icon, label, title, cls, disabled, fn) => {
        const b = document.createElement("button"); b.className = "plaction " + (cls || ""); b.title = title; b.disabled = !!disabled;
        b.appendChild(svgIcon(icon)); b.appendChild(document.createTextNode(label));
        b.addEventListener("click", (e) => { e.stopPropagation(); if (!b.disabled) { fn(); } });
        return b;
    };
    actions.appendChild(mkAction("check", "Clear completed", "Clear completed tasks", "", done === 0, () => clearTodos("done")));
    actions.appendChild(mkAction("trash", "Clear all", "Clear all tasks", "danger", false, () => clearTodos("all")));
    const list = document.createElement("div"); list.className = "pllist";
    for (const t of todos) {
        const item = document.createElement("div");
        item.className = "todoitem" + (t.status === "completed" ? " done" : t.status === "in_progress" ? " active" : "");
        const ord = document.createElement("span"); ord.className = "torder"; ord.textContent = String(t.order || (todos.indexOf(t) + 1)) + ".";
        const mk = document.createElement("span"); mk.className = "tmark" + (t.status === "pending" ? " pending" : "");
        mk.appendChild(todoMark(t.status));
        const c = document.createElement("span"); c.className = "tcontent"; c.textContent = t.content;
        item.appendChild(ord); item.appendChild(mk); item.appendChild(c);
        list.appendChild(item);
    }
    card.appendChild(head); card.appendChild(actions); card.appendChild(list);
    planEl.appendChild(card);
}

// ---- Tasks panel (Sufficit-memory task list, local mirror) ----
let tasksCollapsed = false;   // persisted across re-renders
let tasksShowAll = false;     // header filter: pending-only (default) vs all
let lastTaskItems = [];
let lastTaskProject = "";
const taskPrevDone = new Set();   // done ids seen on the previous render
const taskCompleting = new Set(); // done ids currently animating out (~5s)
export function renderTasks(items, project) {
    lastTaskItems = items || [];
    lastTaskProject = project || "";
    tasksEl.textContent = "";
    if (!items || !items.length) { tasksEl.classList.remove("has"); taskPrevDone.clear(); refreshPanels(); return; }
    // A task that just became done lingers with a completion animation for
    // ~5s (time to notice), then drops from the pending view on re-render.
    for (const it of items) {
        if (it.done && !taskPrevDone.has(it.id)) {
            taskCompleting.add(it.id);
            setTimeout(() => { taskCompleting.delete(it.id); renderTasks(lastTaskItems, lastTaskProject); }, 5200);
        }
    }
    taskPrevDone.clear();
    for (const it of items) { if (it.done) { taskPrevDone.add(it.id); } }

    const pending = items.filter((it) => !it.done);
    const visible = tasksShowAll ? items : items.filter((it) => !it.done || taskCompleting.has(it.id));

    const card = document.createElement("div"); card.className = "tkcard";
    const head = document.createElement("div"); head.className = "tkhead";
    head.appendChild(svgIcon("list"));
    const ttl = document.createElement("span"); ttl.className = "tktitle";
    ttl.textContent = "Tasks";
    ttl.title = "Sufficit memory tasks for this session" + (project ? " — session " + project : "");
    const cnt = document.createElement("span"); cnt.className = "tkcount";
    cnt.textContent = pending.length + "/" + items.length;
    cnt.title = pending.length + " pending of " + items.length + " total";
    const filterBtn = document.createElement("button"); filterBtn.className = "tkbtn tkfilter";
    filterBtn.textContent = tasksShowAll ? "All" : "Pending";
    filterBtn.title = "Show all tasks or only pending";
    filterBtn.addEventListener("click", (e) => { e.stopPropagation(); tasksShowAll = !tasksShowAll; renderTasks(lastTaskItems, lastTaskProject); });
    const refresh = document.createElement("button"); refresh.className = "tkbtn"; refresh.title = "Refresh from memory";
    refresh.appendChild(svgIcon("refresh"));
    refresh.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "refresh-tasks" }); });
    head.appendChild(ttl); head.appendChild(cnt); head.appendChild(filterBtn); head.appendChild(refresh);
    card.appendChild(head);
    const list = document.createElement("div"); list.className = "tklist";
    for (const it of visible) {
        const row = document.createElement("div");
        row.className = "tkitem" + (it.done ? " done" : "") + (taskCompleting.has(it.id) ? " completing" : "");
        const isAnchor = String(it.type || "").indexOf("anchor") >= 0;
        // Clickable status: ○ pending / ✓ done. The USER can toggle it
        // (no agent needed) — clearer than the old "CHECK" badge.
        const status = document.createElement("button");
        status.className = "tkstatus" + (it.done ? " done" : "");
        status.title = it.done ? "Completed — click to reopen" : "Pending — click to mark done";
        status.appendChild(svgIcon(it.done ? "check" : "circleEmpty"));
        status.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "task-set-done", id: it.id, done: !it.done }); });
        if (isAnchor) { row.classList.add("anchor"); }
        const txt = document.createElement("span"); txt.className = "tktext";
        txt.textContent = it.title || it.summary || "(untitled)";
        txt.title = (it.title ? it.title + "\n\n" : "") + (it.summary || "");
        const when = document.createElement("span"); when.className = "tkwhen"; when.textContent = relWhen(it.ts);
        row.appendChild(status); row.appendChild(txt); row.appendChild(when);
        list.appendChild(row);
    }
    card.appendChild(list);
    tasksEl.appendChild(card);
    tasksEl.classList.add("has");
    refreshPanels();
}

// ---- guardrails (agent-defined absolute rules, sent every message) ----
let lastGuardrailItems = [];
export function renderGuardrails(items) {
    lastGuardrailItems = items || [];
    guardrailsEl.textContent = "";
    if (!lastGuardrailItems.length) { guardrailsEl.classList.remove("has"); refreshPanels(); return; }
    const card = document.createElement("div"); card.className = "grcard";
    const head = document.createElement("div"); head.className = "grhead";
    head.appendChild(svgIcon("shield"));
    const ttl = document.createElement("span"); ttl.className = "grtitle"; ttl.textContent = "Guardrails";
    ttl.title = "Absolute rules the agent set for this session, sent on every message. The agent adds them; you can remove or clear them.";
    const cnt = document.createElement("span"); cnt.className = "grcount"; cnt.textContent = String(lastGuardrailItems.length);
    const clear = document.createElement("button"); clear.className = "grbtn"; clear.title = "Clear all guardrails";
    clear.setAttribute("aria-label", "Clear all guardrails");
    clear.appendChild(svgIcon("trash"));
    clear.addEventListener("click", (e) => { e.stopPropagation(); if (lastGuardrailItems.length) { vscode.postMessage({ type: "clear-guardrails" }); } });
    head.appendChild(ttl); head.appendChild(cnt); head.appendChild(clear);
    card.appendChild(head);
    const list = document.createElement("div"); list.className = "grlist";
    for (const it of lastGuardrailItems) {
        const row = document.createElement("div"); row.className = "gritem";
        const txt = document.createElement("span"); txt.className = "grtext"; txt.textContent = it.text; txt.title = it.text;
        const del = document.createElement("button"); del.className = "grdel"; del.title = "Remove"; del.textContent = "✕";
        del.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "remove-guardrail", id: it.id }); });
        row.appendChild(txt); row.appendChild(del);
        list.appendChild(row);
    }
    card.appendChild(list);
    guardrailsEl.appendChild(card);
    guardrailsEl.classList.add("has");
    refreshPanels();
}

// ---- queued messages (editable until dispatched) ----
export function renderQueued(items) {
    setQueued(items.length);   // keep status text in sync
    queuedEl.textContent = "";
    if (!items.length) { queuedEl.classList.remove("has"); setStatus(); return; }
    queuedEl.classList.add("has");
    const head = document.createElement("div"); head.className = "qhead"; head.textContent = "Queued";
    queuedEl.appendChild(head);
    for (const it of items) {
        const row = document.createElement("div"); row.className = "qitem";
        const main = document.createElement("div"); main.className = "qmain";
        const txt = document.createElement("div"); txt.className = "qtext"; txt.textContent = it.text;
        txt.title = "Click to edit"; txt.addEventListener("click", () => vscode.postMessage({ type: "queue-edit", id: it.id }));
        main.appendChild(txt);
        if (it.attachments && it.attachments.length) {
            const atts = document.createElement("div"); atts.className = "qatts";
            for (const p of it.attachments) {
                const chip = document.createElement("span"); chip.className = "qatt"; chip.title = p;
                const ic = svgIcon("file"); ic.classList.add("qattIcon"); chip.appendChild(ic);
                chip.appendChild(document.createTextNode(String(p).split("/").pop() || p));
                atts.appendChild(chip);
            }
            main.appendChild(atts);
        }
        const acts = document.createElement("span"); acts.className = "qacts";
        const mkBtn = (icon, title, type) => {
            const b = document.createElement("button"); b.className = "qbtn"; b.title = title;
            b.appendChild(svgIcon(icon));
            b.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type, id: it.id }); });
            return b;
        };
        acts.appendChild(mkBtn("edit", "Edit", "queue-edit"));
        acts.appendChild(mkBtn("up", "Send next", "queue-promote"));
        acts.appendChild(mkBtn("x", "Remove", "queue-remove"));
        row.appendChild(main); row.appendChild(acts);
        queuedEl.appendChild(row);
    }
    setStatus();
}

// ---- changed-files working set (above the composer) ----
// The edited-files list is OWNED BY THE CONTROLLER (extension side) and
// pushed via {type:"changed-files"}, so it survives view switches and keeps
// approvals resolved. The plan, below, is still session-keyed in the webview.
const NEW_KEY = "__new__";          // placeholder until a session id arrives
let wsKey = NEW_KEY;
export let changedItems: any[] = [];              // [{ path, added, removed }] from controller
// Switch the active PLAN to a session id (changed-files comes from controller).
export function startWorkingSet(sessionId) {
    wsKey = sessionId || NEW_KEY;
    delete planBySession[wsKey];
    renderPlan();
}
export function bindWorkingSet(sessionId) {
    if (!sessionId || wsKey === sessionId) { return; }
    if (wsKey === NEW_KEY && planBySession[NEW_KEY]) {
        planBySession[sessionId] = planBySession[NEW_KEY]; delete planBySession[NEW_KEY];
    }
    wsKey = sessionId;
    renderPlan();
}
export function cfActionBtn(icon, title, cls, onClick) {
    const b = document.createElement("button"); b.className = "cfbtn " + (cls || ""); b.title = title;
    b.appendChild(svgIcon(icon));
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
}
export function cfLabelBtn(icon, label, title, cls, onClick) {
    const b = document.createElement("button"); b.className = "cfbtn labeled " + (cls || ""); b.title = title;
    b.appendChild(svgIcon(icon));
    const t = document.createElement("span"); t.textContent = label; b.appendChild(t);
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
}
export function renderChangedFiles() {
    const items = changedItems;
    changedFiles.textContent = "";
    if (!items.length) { changedFiles.classList.remove("has"); refreshPanels(); return; }
    changedFiles.classList.add("has");
    const head = document.createElement("div"); head.className = "cfhead";
    const ttl = document.createElement("span"); ttl.className = "cftitle"; ttl.textContent = "Edited files (" + items.length + ")";
    head.appendChild(ttl);
    const acts = document.createElement("span"); acts.className = "cfheadActs";
    acts.appendChild(cfLabelBtn("check", "Approve all", "Accept all (git add)", "ok", () => vscode.postMessage({ type: "file-approve-all" })));
    acts.appendChild(cfLabelBtn("x", "Reject all", "Revert all to pre-edit state", "no", () => vscode.postMessage({ type: "file-reject-all" })));
    head.appendChild(acts);
    const list = document.createElement("div"); list.className = "cflist";
    for (const c of items) {
        const p = c.path;
        const parts = p.split("/").filter(Boolean);
        const name = parts[parts.length - 1] || p;
        const dir = parts.slice(-3, -1).join("/");
        const it = document.createElement("div"); it.className = "cfitem"; it.title = p + " — click to diff";
        const fi = fileIcon(name);
        const ic = document.createElement("span"); ic.className = "cficon"; ic.appendChild(svgIcon(fi.i));
        if (fi.c) { ic.style.color = fi.c; ic.style.opacity = "1"; }
        const nm = document.createElement("span"); nm.className = "cfname";
        nm.textContent = name;
        if (dir) { const dd = document.createElement("span"); dd.className = "cfdir"; dd.textContent = "  " + dir; nm.appendChild(dd); }
        const df = document.createElement("span"); df.className = "cfdiff";
        if (c.added) { const a = document.createElement("span"); a.className = "tAdd"; a.textContent = "+" + c.added; df.appendChild(a); }
        if (c.removed) { const r = document.createElement("span"); r.className = "tDel"; r.textContent = "-" + c.removed; df.appendChild(r); }
        it.appendChild(ic); it.appendChild(nm); it.appendChild(df);
        const fa = document.createElement("span"); fa.className = "cfacts";
        fa.appendChild(cfActionBtn("check", "Approve (git add)", "ok", () => vscode.postMessage({ type: "file-approve", path: p })));
        fa.appendChild(cfActionBtn("x", "Reject (revert)", "no", () => vscode.postMessage({ type: "file-reject", path: p })));
        it.appendChild(fa);
        it.addEventListener("click", () => vscode.postMessage({ type: "file-diff", path: p }));
        list.appendChild(it);
    }
    changedFiles.appendChild(head); changedFiles.appendChild(list);
    refreshPanels();
}
// ---- panel tabs: guardrails / tasks / edited-files collapse into an icon
// strip above the composer; click an icon to open that panel (one at a time).
let activePanel = null;   // "guardrails" | "tasks" | "changed" | "attached" | null
// Soft, theme-aware accent per tag type (VS Code chart colors) so each is
// distinguishable at a glance; dimmed by the .ptab opacity so they stay gentle.
export function panelDefs() {
    const pending = lastTaskItems.filter((t) => !t.done).length;
    return [
        { key: "attached", icon: "file", el: attachedPanel, title: "Attached to context", count: chips.children.length, badge: String(chips.children.length), color: "var(--vscode-charts-orange, #d9a45b)" },
        { key: "guardrails", icon: "shield", el: guardrailsEl, title: "Guardrails", count: lastGuardrailItems.length, badge: String(lastGuardrailItems.length), color: "var(--vscode-charts-purple, #b180d7)" },
        { key: "tasks", icon: "list", el: tasksEl, title: "Tasks", count: lastTaskItems.length, badge: pending + "/" + lastTaskItems.length, color: "var(--vscode-charts-blue, #4e9bd6)" },
        { key: "changed", icon: "diff", el: changedFiles, title: "Edited files", count: changedItems.length, badge: String(changedItems.length), color: "var(--vscode-charts-green, #89c374)" },
    ];
}
export function refreshPanels() {
    const defs = panelDefs();
    const shown = defs.filter((d) => d.count > 0);
    if (activePanel && !shown.some((d) => d.key === activePanel)) { activePanel = null; }
    panelTabs.textContent = "";
    for (const d of shown) {
        const b = document.createElement("button");
        b.className = "ptab" + (activePanel === d.key ? " active" : "");
        b.title = d.title; b.setAttribute("aria-label", d.title + " (" + d.count + ")");
        b.style.color = d.color;
        b.appendChild(svgIcon(d.icon));
        const badge = document.createElement("span"); badge.className = "ptBadge"; badge.textContent = d.badge;
        b.appendChild(badge);
        b.addEventListener("click", () => { activePanel = activePanel === d.key ? null : d.key; refreshPanels(); });
        panelTabs.appendChild(b);
    }
    panelTabs.classList.toggle("has", shown.length > 0);
    for (const d of defs) { d.el.style.display = (d.count > 0 && activePanel === d.key) ? "" : "none"; }
    panelBody.classList.toggle("has", activePanel != null && shown.some((d) => d.key === activePanel));
}
export function resetWorkingState() {
    // clear arrives before meta; the controller re-sends changed-files on
    // attach, so just hide the panels here.
    endToolGroup(); endStream();
    changedItems = [];
    changedFiles.textContent = "";
    changedFiles.classList.remove("has");
    planEl.textContent = "";
    planEl.classList.remove("has");
    queuedEl.textContent = "";
    queuedEl.classList.remove("has");
    refreshPanels();
}

export function setChangedItems(v: any[]) { changedItems = v; }
