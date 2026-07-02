// Session filter persistence, matching, sorting, and the filter menu.
// Split out of sessions.ts; these helpers are invoked by renderSessions()
// (which still lives in sessions.ts), hence the cross-import below.
import { saveState } from "./vscode";
import { ctxMenu, sessionFilterBtn } from "./dom";
import {
    sessions,
    sessionSearchTerm,
    sessionGroupBy,
    setSessionGroupBy,
    sessionSort,
    sessionBackendFilter,
    sessionScopeFilter,
    sessionStatusFilter,
    setSessionSort,
    setSessionBackendFilter,
    setSessionStatusFilter,
    setSessionScopeFilter,
} from "./state";
import { t } from "./i18n";
import { renderSessions, backendLabel } from "./sessions";

export function persistSessionFilters() {
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

export function matchesSessionFilters(s: any) {
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

export function matchesSearch(s: any) {
    const q = (sessionSearchTerm || "").trim().toLowerCase();
    if (!q) { return true; }
    const hay = `${s.title || ""} ${backendLabel(s.backend)} ${s.backend || ""}`.toLowerCase();
    return hay.includes(q);
}

export function sortSessions(list: any[]) {
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

export function updateFilterButtonState() {
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
        row.innerHTML = `<span class="tick">${item.active ? "✓" : ""}</span><span>${item.label}</span>`;
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
    head.innerHTML = `<span>${t("sessions.filter.title")}</span><button type="button" class="sessionFilterReset">${t("sessions.filter.clear")}</button>`;
    (head.querySelector("button") as HTMLButtonElement).onclick = (ev) => {
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
