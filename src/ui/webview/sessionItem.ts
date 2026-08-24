// Rendering and interaction for one session-list row.
import { postMessage, saved, saveState } from "./vscode";
import { root } from "./dom";
import { sessions, activeSessionId, setActiveSessionId } from "./state";
import { setLoading } from "./status";
import { showCtx } from "./menus";
import { svgIcon } from "./icons";
import { relTime } from "./format";
import { sessionMetadata } from "./sessionMetadata";
import { t } from "./i18n";
import { refreshSessionList, sessionBackendName } from "./sessionBridge";
import type { SessionListItem } from "./types";

let dragPinId: string | null = null;

// Subagent groups are collapsed by default (accordion): only parents the user
// explicitly expanded are open. We track the EXPANDED set so the default
// (empty) means everything is closed under its main conversation.
const expandedParents = new Set(saved.expandedSubagents || []);
export function toggleCollapsed(id: string): void {
    if (expandedParents.has(id)) {
        expandedParents.delete(id);
    } else {
        expandedParents.add(id);
    }
    saveState({ expandedSubagents: [...expandedParents] });
    refreshSessionList();
}
export function dropPinnedOn(targetId: string): void {
    if (!dragPinId || dragPinId === targetId) {
        return;
    }
    const order = sessions
        .filter((s) => s.pinned)
        .sort((a, b) => (a.pinIndex || 0) - (b.pinIndex || 0))
        .map((s) => s.sessionId);
    const from = order.indexOf(dragPinId),
        to = order.indexOf(targetId);
    if (from < 0 || to < 0) {
        return;
    }
    order.splice(from, 1);
    order.splice(order.indexOf(targetId), 0, dragPinId);
    // Optimistic reorder so it feels instant, then persist.
    const idx: Record<string, number> = {};
    order.forEach((id, i) => (idx[id] = i));
    for (const s of sessions) {
        if (s.pinned) {
            s.pinIndex = idx[s.sessionId];
        }
    }
    refreshSessionList();
    postMessage({ type: "reorder-pinned", ids: order });
}
export function renderSessionItem(
    s: SessionListItem,
    depth: number,
    childCount: number,
): HTMLDivElement {
    depth = depth || 0;
    childCount = childCount || 0;
    const isSubagent = !!s.parentId;
    const el = document.createElement("div");
    el.className =
        "sessionItem" +
        (s.sessionId === activeSessionId ? " active" : "") +
        (s.archived ? " archived" : "") +
        (s.pinned ? " pinned" : "") +
        (s.deleting ? " deleting" : "") +
        (isSubagent ? " subagentChild" : "");
    if (depth) {
        el.style.marginLeft = depth * 16 + "px";
    }
    // Caret to collapse/expand a parent's subagent children.
    let caretEl: HTMLButtonElement | null = null;
    if (childCount > 0) {
        caretEl = document.createElement("button");
        caretEl.className = "subCaret";
        caretEl.style.cssText =
            "background:none;border:none;cursor:pointer;padding:0 2px;display:flex;align-items:center;opacity:0.7";
        const collapsed = !expandedParents.has(s.sessionId);
        const cv = svgIcon("chevron");
        cv.style.transform = collapsed ? "rotate(-90deg)" : "rotate(0deg)";
        cv.style.transition = "transform 150ms ease";
        caretEl.appendChild(cv);
        caretEl.title = collapsed ? "Expand subagents" : "Collapse subagents";
        caretEl.setAttribute("aria-label", caretEl.title);
        caretEl.addEventListener("click", (ev) => {
            ev.stopPropagation();
            toggleCollapsed(s.sessionId);
        });
    }
    el.tabIndex = 0;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", s.sessionId === activeSessionId ? "true" : "false");
    const item = el as HTMLElement;
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            body.click();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const next = item.nextElementSibling as HTMLElement | null;
            if (next?.classList.contains("sessionItem")) {
                next.focus();
            } else {
                const after = item.parentElement?.querySelectorAll(".sessionItem") || [];
                const idx = Array.from(after).indexOf(item);
                if (idx + 1 < after.length) {
                    (after[idx + 1] as HTMLElement).focus();
                }
            }
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const prev = item.previousElementSibling as HTMLElement | null;
            if (prev?.classList.contains("sessionItem")) {
                prev.focus();
            } else {
                const all = item.parentElement?.querySelectorAll(".sessionItem") || [];
                const idx = Array.from(all).indexOf(item);
                if (idx > 0) {
                    (all[idx - 1] as HTMLElement).focus();
                }
            }
        }
    });
    // Pinned items reorder by drag-and-drop (the up/down menu still works).
    if (s.pinned) {
        el.draggable = true;
        el.addEventListener("dragstart", (e) => {
            dragPinId = s.sessionId;
            el.classList.add("dragging");
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        el.addEventListener("dragend", () => {
            dragPinId = null;
            el.classList.remove("dragging");
            document
                .querySelectorAll(".sessionItem.dropTarget")
                .forEach((x) => x.classList.remove("dropTarget"));
        });
        el.addEventListener("dragover", (e) => {
            if (dragPinId && dragPinId !== s.sessionId) {
                e.preventDefault();
                el.classList.add("dropTarget");
            }
        });
        el.addEventListener("dragleave", () => el.classList.remove("dropTarget"));
        el.addEventListener("drop", (e) => {
            e.preventDefault();
            el.classList.remove("dropTarget");
            dropPinnedOn(s.sessionId);
        });
    }

    // Live status indicator: spinner = working, green dot = idle/live,
    // red dot = the last turn stopped with an error requiring attention.
    // Subagent sessions (parentId != null) show robot icon for visual distinction.
    const statusDot = document.createElement("div");
    statusDot.className = "statusDot";
    let statusLabel = t("sessions.status.stored");
    if (s.deleting) {
        statusLabel = t("sessions.status.deleting");
        const sp = document.createElement("span");
        sp.className = "spinner";
        sp.title = statusLabel;
        statusDot.appendChild(sp);
    } else if (s.status === "working") {
        statusLabel = t("sessions.status.working");
        const w = document.createElement("span");
        w.className = "work";
        w.title = statusLabel;
        statusDot.appendChild(w);
    } else if (s.status === "error") {
        statusLabel = t("sessions.status.error");
        const e = document.createElement("span");
        e.className = "error";
        e.title = statusLabel;
        statusDot.appendChild(e);
    } else if (s.status === "warning") {
        statusLabel = t("sessions.status.warning");
        const w = document.createElement("span");
        w.className = "warning";
        w.title = statusLabel;
        statusDot.appendChild(w);
    } else if (s.status === "idle") {
        statusLabel = t("sessions.status.idle");
        const d = document.createElement("span");
        d.className = "idle";
        d.title = statusLabel;
        statusDot.appendChild(d);
    } else {
        const ic = svgIcon(isSubagent ? "robot" : "chat");
        ic.classList.add("stored");
        if (isSubagent) {
            ic.classList.add("subagentIcon");
        }
        ic.setAttribute("aria-hidden", "true");
        statusDot.appendChild(ic);
    }
    el.setAttribute("aria-label", `${s.title} — ${statusLabel}`);

    const body = document.createElement("div");
    body.className = "body";
    const ttl = document.createElement("div");
    ttl.className = "ttl";
    if (isSubagent) {
        const rb = svgIcon("robot");
        rb.classList.add("ttlIcon", "subagentBadge");
        ttl.appendChild(rb);
    }
    if (s.pinned) {
        const pn = svgIcon("pin");
        pn.classList.add("ttlIcon");
        ttl.appendChild(pn);
    }
    if (s.archived) {
        const ar = svgIcon("archive");
        ar.classList.add("ttlIcon");
        ttl.appendChild(ar);
    }
    ttl.appendChild(document.createTextNode(s.title));
    ttl.title = s.title + "\n" + s.sessionId;
    const sub = document.createElement("span");
    sub.className = "sub";
    if (s.deleting) {
        sub.textContent = t("sessions.status.deleting") + "…";
    } else {
        const statusText =
            s.status === "working"
                ? t("sessions.status.working") + "… · "
                : s.status === "idle"
                  ? t("sessions.status.idle") + " · "
                  : s.status === "error"
                    ? t("sessions.status.error") + " · "
                    : s.status === "warning"
                      ? t("sessions.status.warning") + " · "
                      : "";
        const metadata = sessionMetadata({
            backend: s.backend,
            backendName: s.backendName || sessionBackendName(s.backend),
            model: s.model,
            reasoning: s.reasoning,
            updatedAt: s.updatedAt,
            relativeTime: s.updatedAt ? relTime(s.updatedAt) : "",
        });
        sub.textContent = statusText + metadata.visible;
        sub.title = metadata.tooltip;
    }
    if (s.deleting) {
        sub.title = t("sessions.status.deleting");
    }
    body.appendChild(ttl);
    body.appendChild(sub);
    // While a delete scrub is in flight the row is inert (no open / no menu).
    if (!s.deleting) {
        body.addEventListener("click", () => {
            root.classList.remove("listOpen");
            setActiveSessionId(s.sessionId);
            refreshSessionList();
            setLoading(true, "Loading session…");
            postMessage({
                type: "open-session",
                sessionId: s.sessionId,
                backend: s.backend,
            });
        });
        // Double-click: force open in editor tab (center), regardless of openIn pref.
        el.addEventListener("dblclick", () => {
            postMessage({
                type: "open-session-editor",
                sessionId: s.sessionId,
                backend: s.backend,
            });
        });
    }

    // One "more" button opens the same menu as right-click.
    const acts = document.createElement("div");
    acts.className = "acts";
    if (!s.deleting) {
        const more = document.createElement("button");
        more.appendChild(svgIcon("more"));
        more.title = "Actions";
        more.setAttribute("aria-label", "Actions");
        more.addEventListener("click", (ev) => {
            ev.stopPropagation();
            showCtx(ev, s);
        });
        acts.appendChild(more);
    }

    if (caretEl) {
        el.appendChild(caretEl);
    }
    el.appendChild(statusDot);
    el.appendChild(body);
    el.appendChild(acts);
    if (!s.deleting) {
        el.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            showCtx(ev, s);
        });
    }
    return el;
}

export function isParentExpanded(sessionId: string): boolean {
    return expandedParents.has(sessionId);
}
