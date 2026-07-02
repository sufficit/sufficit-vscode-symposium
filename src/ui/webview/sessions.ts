// Sessions list + account footer rendering.
import { vscode, saved, saveState } from "./vscode";
import { sessionsList, root, ctxMenu, sessionFilterBtn } from "./dom";
import { sessions, activeSessionId, showArchived, sessionSearchTerm, sessionGroupBy, setSessionGroupBy, setActiveSessionId, sessionBackendFilter, sessionScopeFilter, sessionSort, sessionStatusFilter, setSessionBackendFilter, setSessionScopeFilter, setSessionSort, setSessionStatusFilter } from "./state";
import { setLoading } from "./status";
import { showCtx } from "./menus";
import { svgIcon } from "./icons";
import { bucket, relTime } from "./format";
import { t } from "./i18n";

let dragPinId: any = null;

const BACKEND_LABELS: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    copilot: "Copilot",
};

function backendLabel(backend: string): string {
    if (backend === "openai") { return t("backend.openai"); }
    return BACKEND_LABELS[backend] || backend;
}

function persistSessionFilters() {
    saveState({
        sessionFilters: {
            sort: sessionSort,
            groupBy: sessionGroupBy,
            backends: [...sessionBackendFilter],
            statuses: [...sessionStatusFilter],
            scopes: [...sessionScopeFilter],
        },
    });
}

function toggleIn(list: string[], value: string, setter: (v: string[]) => void) {
    const next = list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
    setter(next);
    persistSessionFilters();
    renderSessions();
}

function matchesSessionFilters(s: any) {
    if (sessionBackendFilter.length && !sessionBackendFilter.includes(String(s.backend || ""))) { return false; }
    if (sessionStatusFilter.length) {
        const statusTags = new Set<string>();
        if (s.status === "working") { statusTags.add("working"); }
        if (s.status === "idle" || !s.status) { statusTags.add("idle"); }
        if (s.deleting) { statusTags.add("deleting"); }
        if (s.parentId) { statusTags.add("subagent"); }
        if (!sessionStatusFilter.some((tag) => statusTags.has(tag))) { return false; }
    }
    if (sessionScopeFilter.length) {
        const scopeTags = new Set<string>();
        scopeTags.add(s.cwd ? "workspace" : "imported");
        scopeTags.add(s.parentId ? "child" : "top");
        if (!sessionScopeFilter.some((tag) => scopeTags.has(tag))) { return false; }
    }
    return true;
}

function matchesSearch(s: any) {
    const q = (sessionSearchTerm || "").trim().toLowerCase();
    if (!q) { return true; }
    const hay = `${s.title || ""} ${backendLabel(s.backend)} ${s.backend || ""}`.toLowerCase();
    return hay.includes(q);
}

function sortSessions(list: any[]) {
    const copy = [...list];
    copy.sort((a, b) => {
        if (sessionSort === "title-asc") { return String(a.title || "").localeCompare(String(b.title || "")); }
        const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return sessionSort === "updated-asc" ? at - bt : bt - at;
    });
    return copy;
}

function activeFilterCount() {
    return sessionBackendFilter.length + sessionStatusFilter.length + sessionScopeFilter.length + (sessionSort !== "updated-desc" ? 1 : 0);
}

function updateFilterButtonState() {
    if (!sessionFilterBtn) { return; }
    const n = activeFilterCount();
    sessionFilterBtn.classList.toggle("active", n > 0);
    sessionFilterBtn.title = n > 0 ? t("sessions.filter.activeTooltip", { n }) : t("sessions.filter.tooltip");
    sessionFilterBtn.setAttribute("aria-label", sessionFilterBtn.title);
}

function appendFilterSection(title: string, items: Array<{ label: string; active: boolean; onToggle: () => void }>) {
    const group = document.createElement("div");
    group.className = "sessionFilterGroup";
    const h = document.createElement("div");
    h.className = "sessionFilterTitle";
    h.textContent = title;
    group.appendChild(h);
    for (const item of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "sessionFilterItem" + (item.active ? " active" : "");
        const tick = document.createElement("span");
        tick.className = "tick";
        tick.textContent = item.active ? "✓" : "";
        const lbl = document.createElement("span");
        lbl.textContent = item.label;
        row.appendChild(tick);
        row.appendChild(lbl);
        row.onclick = (ev) => { ev.stopPropagation(); item.onToggle(); openSessionsFilterMenu(sessionFilterBtn); };
        group.appendChild(row);
    }
    ctxMenu.appendChild(group);
}

export function openSessionsFilterMenu(anchorEl: HTMLElement) {
    ctxMenu.textContent = "";
    ctxMenu.classList.add("sessionFiltersMenu");

    const head = document.createElement("div");
    head.className = "sessionFilterHead";
    const headTitle = document.createElement("span");
    headTitle.textContent = t("sessions.filter.title");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "sessionFilterReset";
    reset.textContent = t("sessions.filter.clear");
    head.appendChild(headTitle);
    head.appendChild(reset);
    reset.onclick = (ev) => {
        ev.stopPropagation();
        setSessionSort("updated-desc");
        setSessionBackendFilter([]);
        setSessionStatusFilter([]);
        setSessionScopeFilter([]);
        persistSessionFilters();
        renderSessions();
        openSessionsFilterMenu(anchorEl);
    };
    ctxMenu.appendChild(head);

    appendFilterSection(t("sessions.group.label"), [
        { label: t("sessions.group.none"), active: sessionGroupBy === "none", onToggle: () => { setSessionGroupBy("none"); persistSessionFilters(); renderSessions(); } },
        { label: t("sessions.group.projectConversation"), active: sessionGroupBy === "project-conversation", onToggle: () => { setSessionGroupBy("project-conversation"); persistSessionFilters(); renderSessions(); } },
        { label: t("sessions.group.conversation"), active: sessionGroupBy === "conversation", onToggle: () => { setSessionGroupBy("conversation"); persistSessionFilters(); renderSessions(); } },
        { label: t("sessions.group.time"), active: sessionGroupBy === "time", onToggle: () => { setSessionGroupBy("time"); persistSessionFilters(); renderSessions(); } },
        { label: t("sessions.group.project"), active: sessionGroupBy === "project", onToggle: () => { setSessionGroupBy("project"); persistSessionFilters(); renderSessions(); } },
        { label: t("sessions.group.branch"), active: sessionGroupBy === "branch", onToggle: () => { setSessionGroupBy("branch"); persistSessionFilters(); renderSessions(); } },
    ]);

    appendFilterSection(t("sessions.filter.sort"), [
        { label: t("sessions.sort.newest"), active: sessionSort === "updated-desc", onToggle: () => { setSessionSort("updated-desc"); persistSessionFilters(); renderSessions(); } },
        { label: t("sessions.sort.oldest"), active: sessionSort === "updated-asc", onToggle: () => { setSessionSort("updated-asc"); persistSessionFilters(); renderSessions(); } },
        { label: t("sessions.sort.title"), active: sessionSort === "title-asc", onToggle: () => { setSessionSort("title-asc"); persistSessionFilters(); renderSessions(); } },
    ]);

    const backends = [...new Set(sessions.map((s) => String(s.backend || "")).filter(Boolean))].sort();
    if (backends.length) {
        appendFilterSection(t("sessions.filter.agent"), backends.map((backend) => ({
            label: backendLabel(backend),
            active: sessionBackendFilter.includes(backend),
            onToggle: () => toggleIn(sessionBackendFilter, backend, setSessionBackendFilter),
        })));
    }

    appendFilterSection(t("sessions.filter.status"), [
        { label: t("sessions.status.working"), active: sessionStatusFilter.includes("working"), onToggle: () => toggleIn(sessionStatusFilter, "working", setSessionStatusFilter) },
        { label: t("sessions.status.idle"), active: sessionStatusFilter.includes("idle"), onToggle: () => toggleIn(sessionStatusFilter, "idle", setSessionStatusFilter) },
        { label: t("sessions.status.subagent"), active: sessionStatusFilter.includes("subagent"), onToggle: () => toggleIn(sessionStatusFilter, "subagent", setSessionStatusFilter) },
        { label: t("sessions.status.deleting"), active: sessionStatusFilter.includes("deleting"), onToggle: () => toggleIn(sessionStatusFilter, "deleting", setSessionStatusFilter) },
    ]);

    appendFilterSection(t("sessions.filter.scope"), [
        { label: t("sessions.scope.workspace"), active: sessionScopeFilter.includes("workspace"), onToggle: () => toggleIn(sessionScopeFilter, "workspace", setSessionScopeFilter) },
        { label: t("sessions.scope.imported"), active: sessionScopeFilter.includes("imported"), onToggle: () => toggleIn(sessionScopeFilter, "imported", setSessionScopeFilter) },
        { label: t("sessions.scope.top"), active: sessionScopeFilter.includes("top"), onToggle: () => toggleIn(sessionScopeFilter, "top", setSessionScopeFilter) },
        { label: t("sessions.scope.child"), active: sessionScopeFilter.includes("child"), onToggle: () => toggleIn(sessionScopeFilter, "child", setSessionScopeFilter) },
    ]);

    ctxMenu.style.display = "block";
    const r = anchorEl.getBoundingClientRect();
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";
    ctxMenu.style.top = Math.max(4, Math.min(r.bottom + 4, window.innerHeight - h - 4)) + "px";
}

// Subagent groups are collapsed by default (accordion): only parents the user
// explicitly expanded are open. We track the EXPANDED set so the default
// (empty) means everything is closed under its main conversation.
const expandedParents = new Set(saved.expandedSubagents || []);
export function toggleCollapsed(id) {
    if (expandedParents.has(id)) { expandedParents.delete(id); } else { expandedParents.add(id); }
    saveState({ expandedSubagents: [...expandedParents] });
    renderSessions();
}
export function groupHeader(label, count) {
    const gh = document.createElement("div"); gh.className = "groupHeader";
    const gl = document.createElement("span"); gl.textContent = label;
    const gc = document.createElement("span"); gc.className = "gcount"; gc.textContent = String(count);
    gh.appendChild(gl); gh.appendChild(gc);
    return gh;
}

// Project/branch groups (accordion): collapsed by default — only groups the
// user explicitly expanded are open.
const expandedGroups = new Set(saved.expandedSessionGroups || []);
function toggleGroup(key) {
    if (expandedGroups.has(key)) { expandedGroups.delete(key); } else { expandedGroups.add(key); }
    saveState({ expandedSessionGroups: [...expandedGroups] });
    renderSessions();
}
/** Friendly name for a cwd: the claude-mem observer dir is special-cased, else the last path segment. */
function projectName(cwd) {
    if (!cwd) { return t("sessions.group.noProject"); }
    if (String(cwd).indexOf(".claude-mem") >= 0) { return t("sessions.group.memoryObserver"); }
    const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || String(cwd);
}
/** Collapsible group header (caret + label + count) for project/branch grouping. */
function collapsibleGroupHeader(key, label, count, expanded) {
    const gh = document.createElement("div");
    gh.className = "groupHeader collapsible" + (expanded ? " expanded" : "");
    const cv = svgIcon("chevron");
    cv.classList.add("groupCaret");
    cv.style.transform = expanded ? "rotate(0deg)" : "rotate(-90deg)";
    cv.style.transition = "transform 150ms ease";
    gh.appendChild(cv);
    const gl = document.createElement("span"); gl.className = "glabel"; gl.textContent = label; gl.title = label;
    const gc = document.createElement("span"); gc.className = "gcount"; gc.textContent = String(count);
    gh.appendChild(gl); gh.appendChild(gc);
    gh.onclick = () => toggleGroup(key);
    return gh;
}
export function renderAccount(profile) {
    const el = document.getElementById("accountFooter");
    if (!el) { return; }
    el.textContent = "";
    if (profile && (profile.name || profile.email)) {
        if (profile.picture) {
            const img = document.createElement("img");
            img.setAttribute("src", profile.picture); img.alt = "";
            el.appendChild(img);
        } else {
            const ic = document.createElement("div");
            ic.className = "acc-ico";
            ic.textContent = (profile.name || profile.email || "?").trim().charAt(0).toUpperCase();
            el.appendChild(ic);
        }
        const txt = document.createElement("div");
        txt.className = "acc-text";
        const nm = document.createElement("div");
        nm.className = "acc-name"; nm.textContent = profile.name || profile.email;
        txt.appendChild(nm);
        if (profile.name && profile.email) {
            const sub = document.createElement("div");
            sub.className = "acc-sub"; sub.textContent = profile.email;
            txt.appendChild(sub);
        }
        el.appendChild(txt);
        const out = document.createElement("span");
        out.className = "acc-out"; out.title = "Sair"; out.textContent = "⎋";
        out.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: "account-logout" }); };
        el.appendChild(out);
        el.onclick = null;
    } else {
        const ic = document.createElement("div");
        ic.className = "acc-ico"; ic.textContent = "↪";
        el.appendChild(ic);
        const txt = document.createElement("div");
        txt.className = "acc-text";
        const nm = document.createElement("div");
        nm.className = "acc-name"; nm.textContent = "Entrar na Sufficit";
        txt.appendChild(nm);
        el.appendChild(txt);
        el.onclick = () => vscode.postMessage({ type: "account-login" });
    }
}
export function renderSessions() {
    sessionsList.textContent = "";
    updateFilterButtonState();
    const visible = sortSessions(sessions.filter((s) => (!s.archived || showArchived) && matchesSearch(s) && matchesSessionFilters(s)));
    // Subagents (parentId pointing at a visible session) render nested under
    // their parent — not as top-level rows — so the list stays a tidy tree.
    const byId = new Map(visible.map((s) => [s.sessionId, s]));
    const childrenOf = (id) => visible.filter((s) => s.parentId && s.parentId === id);
    const isChild = (s) => s.parentId && byId.has(s.parentId);
    const top = visible.filter((s) => !isChild(s));
    // Append a row and, when expanded, its subagent children (recursively).
    const appendTree = (s, depth) => {
        const kids = childrenOf(s.sessionId);
        sessionsList.appendChild(renderSessionItem(s, depth, kids.length));
        if (kids.length && expandedParents.has(s.sessionId)) {
            for (const k of kids) { appendTree(k, depth + 1); }
        }
    };
    // Collapse a list of sessions into conversation lineages: the latest session
    // of each lineage is the head; its older sessions nest below in descending
    // order (accordion, collapsed by default). Reused by "Conversation" and the
    // inner level of "Project + Conversation".
    const byRecent = (a, b) => (b.updatedAt ? new Date(b.updatedAt).getTime() : 0) - (a.updatedAt ? new Date(a.updatedAt).getTime() : 0);
    const conversationKeyOf = (s) => `${String(s.backend || "")}:${String(s.lineageId || s.sessionId)}`;
    const appendLineages = (items) => {
        const lin = new Map();
        for (const s of items) {
            const k = conversationKeyOf(s);
            if (!lin.has(k)) { lin.set(k, []); }
            lin.get(k).push(s);
        }
        const lineages = [...lin.values()].map((arr) => [...arr].sort(byRecent));
        lineages.sort((a, b) => byRecent(a[0], b[0]));
        for (const arr of lineages) {
            const head = arr[0];
            const older = arr.slice(1);
            sessionsList.appendChild(renderSessionItem(head, 0, older.length));
            if (older.length && expandedParents.has(head.sessionId)) {
                for (const o of older) { sessionsList.appendChild(renderSessionItem(o, 1, 0)); }
            }
        }
    };
    const pinned = sortSessions(top.filter((s) => s.pinned)).sort((a, b) => (a.pinIndex || 0) - (b.pinIndex || 0));
    const rest = sortSessions(top.filter((s) => !s.pinned));
    if (pinned.length) {
        sessionsList.appendChild(groupHeader("Pinned", pinned.length));
        for (const s of pinned) { appendTree(s, 0); }
    }
    if (sessionGroupBy === "none") {
        for (const s of rest) { appendTree(s, 0); }
    } else if (sessionGroupBy === "time") {
        let lastBucket = null;
        for (const s of rest) {
            const bk = bucket(s.updatedAt);
            if (bk !== lastBucket) {
                lastBucket = bk;
                const count = rest.filter((x) => bucket(x.updatedAt) === bk).length;
                sessionsList.appendChild(groupHeader(bk, count));
            }
            appendTree(s, 0);
        }
    } else if (sessionGroupBy === "conversation") {
        // ONE logical conversation = one entry (latest session as head + older nested).
        appendLineages(rest);
    } else {
        // Group by project (cwd) or git branch — collapsible accordion, closed by
        // default. "project-conversation" groups by project AND collapses each
        // conversation lineage inside it (latest head + older nested).
        const useLineages = sessionGroupBy === "project-conversation";
        const byBranch = sessionGroupBy === "branch";
        const keyOf = (s) => byBranch ? (s.gitBranch || "__nobranch__") : (s.cwd || "__noproject__");
        const labelOf = (s) => byBranch ? (s.gitBranch || t("sessions.group.noBranch")) : projectName(s.cwd);
        const groups = new Map();
        for (const s of rest) {
            const k = keyOf(s);
            if (!groups.has(k)) { groups.set(k, { label: labelOf(s), items: [], recent: 0 }); }
            const g = groups.get(k);
            g.items.push(s);
            const ts = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
            if (ts > g.recent) { g.recent = ts; }
        }
        const keys = [...groups.keys()].sort((a, b) => groups.get(b).recent - groups.get(a).recent);
        for (const k of keys) {
            const g = groups.get(k);
            const expanded = expandedGroups.has(k);
            // In the combined mode the count is the number of CONVERSATIONS, not sessions.
            const count = useLineages ? new Set(g.items.map((s) => conversationKeyOf(s))).size : g.items.length;
            sessionsList.appendChild(collapsibleGroupHeader(k, g.label, count, expanded));
            if (expanded) {
                if (useLineages) { appendLineages(g.items); }
                else { for (const s of g.items) { appendTree(s, 0); } }
            }
        }
    }
}
export function dropPinnedOn(targetId) {
    if (!dragPinId || dragPinId === targetId) { return; }
    const order = sessions.filter((s) => s.pinned).sort((a, b) => (a.pinIndex || 0) - (b.pinIndex || 0)).map((s) => s.sessionId);
    const from = order.indexOf(dragPinId), to = order.indexOf(targetId);
    if (from < 0 || to < 0) { return; }
    order.splice(from, 1);
    order.splice(order.indexOf(targetId), 0, dragPinId);
    // Optimistic reorder so it feels instant, then persist.
    const idx = {}; order.forEach((id, i) => idx[id] = i);
    for (const s of sessions) { if (s.pinned) { s.pinIndex = idx[s.sessionId]; } }
    renderSessions();
    vscode.postMessage({ type: "reorder-pinned", ids: order });
}
export function renderSessionItem(s, depth, childCount) {
        depth = depth || 0; childCount = childCount || 0;
        const isSubagent = !!s.parentId;
        const el = document.createElement("div");
        el.className = "sessionItem" + (s.sessionId === activeSessionId ? " active" : "") + (s.archived ? " archived" : "") + (s.pinned ? " pinned" : "") + (s.deleting ? " deleting" : "") + (isSubagent ? " subagentChild" : "");
        if (depth) { el.style.marginLeft = (depth * 16) + "px"; }
        // Caret to collapse/expand a parent's subagent children.
        let caretEl = null;
        if (childCount > 0) {
            caretEl = document.createElement("button");
            caretEl.className = "subCaret";
            caretEl.style.cssText = "background:none;border:none;cursor:pointer;padding:0 2px;display:flex;align-items:center;opacity:0.7";
            const collapsed = !expandedParents.has(s.sessionId);
            const cv = svgIcon("chevron");
            cv.style.transform = collapsed ? "rotate(-90deg)" : "rotate(0deg)";
            cv.style.transition = "transform 150ms ease";
            caretEl.appendChild(cv);
            caretEl.title = collapsed ? "Expand subagents" : "Collapse subagents";
            caretEl.setAttribute("aria-label", caretEl.title);
            caretEl.addEventListener("click", (ev) => { ev.stopPropagation(); toggleCollapsed(s.sessionId); });
        }
        el.tabIndex = 0;
        el.setAttribute("role", "option");
        el.setAttribute("aria-selected", s.sessionId === activeSessionId ? "true" : "false");
        el.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); body.click(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); const next = el.nextElementSibling; if (next && next.classList.contains("sessionItem")) { next.focus(); } else { const after = el.parentElement.querySelectorAll(".sessionItem"); const idx = Array.from(after).indexOf(el); if (idx + 1 < after.length) { after[idx + 1].focus(); } } }
            else if (e.key === "ArrowUp") { e.preventDefault(); const prev = el.previousElementSibling; if (prev && prev.classList.contains("sessionItem")) { prev.focus(); } else { const all = el.parentElement.querySelectorAll(".sessionItem"); const idx = Array.from(all).indexOf(el); if (idx > 0) { all[idx - 1].focus(); } } }
        });
        // Pinned items reorder by drag-and-drop (the up/down menu still works).
        if (s.pinned) {
            el.draggable = true;
            el.addEventListener("dragstart", (e) => { dragPinId = s.sessionId; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
            el.addEventListener("dragend", () => { dragPinId = null; el.classList.remove("dragging"); document.querySelectorAll(".sessionItem.dropTarget").forEach((x) => x.classList.remove("dropTarget")); });
            el.addEventListener("dragover", (e) => { if (dragPinId && dragPinId !== s.sessionId) { e.preventDefault(); el.classList.add("dropTarget"); } });
            el.addEventListener("dragleave", () => el.classList.remove("dropTarget"));
            el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("dropTarget"); dropPinnedOn(s.sessionId); });
        }

        // Live status indicator: spinner = working, green dot = idle/live.
        // Subagent sessions (parentId != null) show robot icon for visual distinction.
        const statusDot = document.createElement("div");
        statusDot.className = "statusDot";
        if (s.deleting) {
            const sp = document.createElement("span"); sp.className = "spinner"; sp.title = "Deleting…"; statusDot.appendChild(sp);
        } else if (s.status === "working") {
            const w = document.createElement("span"); w.className = "work"; w.title = "Agent working…"; statusDot.appendChild(w);
        } else if (s.status === "idle") {
            const d = document.createElement("span"); d.className = "idle"; d.title = "Running session (idle)"; statusDot.appendChild(d);
        } else {
            const ic = svgIcon(isSubagent ? "robot" : "chat");
            ic.classList.add("stored");
            if (isSubagent) { ic.classList.add("subagentIcon"); }
            ic.setAttribute("aria-hidden", "true");
            statusDot.appendChild(ic);
        }

        const body = document.createElement("div");
        body.className = "body";
        const ttl = document.createElement("div");
        ttl.className = "ttl";
        if (isSubagent) { const rb = svgIcon("robot"); rb.classList.add("ttlIcon", "subagentBadge"); ttl.appendChild(rb); }
        if (s.pinned) { const pn = svgIcon("pin"); pn.classList.add("ttlIcon"); ttl.appendChild(pn); }
        if (s.archived) { const ar = svgIcon("archive"); ar.classList.add("ttlIcon"); ttl.appendChild(ar); }
        ttl.appendChild(document.createTextNode(s.title));
        ttl.title = s.title + "\n" + s.sessionId;
        const sub = document.createElement("span");
        sub.className = "sub";
        if (s.deleting) {
            sub.textContent = "deleting…";
        } else {
            const statusText = s.status === "working" ? "working… · " : (s.status === "idle" ? "live · " : "");
            sub.textContent = statusText + s.backend + (s.updatedAt ? " · " + relTime(s.updatedAt) : "");
        }
        sub.title = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
        body.appendChild(ttl);
        body.appendChild(sub);
        // While a delete scrub is in flight the row is inert (no open / no menu).
        if (!s.deleting) {
            body.addEventListener("click", () => {
                root.classList.remove("listOpen");
                setActiveSessionId(s.sessionId); renderSessions();
                setLoading(true, "Loading session…");
                vscode.postMessage({ type: "open-session", sessionId: s.sessionId, backend: s.backend });
            });
        }

        // One "more" button opens the same menu as right-click.
        const acts = document.createElement("div");
        acts.className = "acts";
        if (!s.deleting) {
            const more = document.createElement("button");
            more.appendChild(svgIcon("more")); more.title = "Actions"; more.setAttribute("aria-label", "Actions");
            more.addEventListener("click", (ev) => { ev.stopPropagation(); showCtx(ev, s); });
            acts.appendChild(more);
        }

        if (caretEl) { el.appendChild(caretEl); }
        el.appendChild(statusDot);
        el.appendChild(body);
        el.appendChild(acts);
        if (!s.deleting) {
            el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); showCtx(ev, s); });
        }
        return el;
}
