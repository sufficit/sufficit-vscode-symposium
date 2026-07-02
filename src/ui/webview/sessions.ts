// Sessions list + account footer rendering.
import { vscode, saved, saveState } from "./vscode";
import { sessionsList, root } from "./dom";
import { sessions, activeSessionId, showArchived, sessionGroupBy, setActiveSessionId } from "./state";
import { setLoading } from "./status";
import { showCtx } from "./menus";
import { svgIcon } from "./icons";
import { bucket, relTime } from "./format";
import { t } from "./i18n";
// Filter persistence / matching / sorting / menu live in sessionFilters.ts;
// import the helpers renderSessions() depends on and re-export the menu so the
// existing index.ts import (`from "./sessions"`) keeps working unchanged.
import { matchesSessionFilters, matchesSearch, sortSessions, updateFilterButtonState } from "./sessionFilters";
export { openSessionsFilterMenu } from "./sessionFilters";

let dragPinId: any = null;

const BACKEND_LABELS: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    copilot: "Copilot",
};

export function backendLabel(backend: string): string {
    if (backend === "openai") { return t("backend.openai"); }
    return BACKEND_LABELS[backend] || backend;
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
