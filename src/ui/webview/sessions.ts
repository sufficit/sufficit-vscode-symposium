// Sessions list + account footer rendering.
import { postMessage, saved, saveState } from "./vscode";
import { sessionsList } from "./dom";
import { sessions, sessionsLoaded, showArchived, sessionGroupBy } from "./state";
import { svgIcon } from "./icons";
import { bucket } from "./format";
import { t } from "./i18n";
// Filter persistence / matching / sorting / menu live in sessionFilters.ts;
// import the helpers renderSessions() depends on and re-export the menu so the
// existing index.ts import (`from "./sessions"`) keeps working unchanged.
import {
    matchesSessionFilters,
    matchesSearch,
    sortSessions,
    updateFilterButtonState,
} from "./sessionFilters";
import { registerSessionBridge } from "./sessionBridge";
import { isParentExpanded, renderSessionItem } from "./sessionItem";
export { dropPinnedOn, renderSessionItem, toggleCollapsed } from "./sessionItem";
import type { AccountProfile, SessionListItem } from "./types";
export { openSessionsFilterMenu } from "./sessionFilters";

const BACKEND_LABELS: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    copilot: "Copilot",
};

export function backendLabel(backend: string): string {
    if (backend === "openai") {
        return t("backend.openai");
    }
    return BACKEND_LABELS[backend] || backend;
}

export function groupHeader(label: string, count: number): HTMLDivElement {
    const gh = document.createElement("div");
    gh.className = "groupHeader";
    const gl = document.createElement("span");
    gl.textContent = label;
    const gc = document.createElement("span");
    gc.className = "gcount";
    gc.textContent = String(count);
    gh.appendChild(gl);
    gh.appendChild(gc);
    return gh;
}

// Project/branch groups (accordion): collapsed by default — only groups the
// user explicitly expanded are open.
const expandedGroups = new Set(saved.expandedSessionGroups || []);
function toggleGroup(key: string): void {
    if (expandedGroups.has(key)) {
        expandedGroups.delete(key);
    } else {
        expandedGroups.add(key);
    }
    saveState({ expandedSessionGroups: [...expandedGroups] });
    renderSessions();
}
/** Friendly name for a cwd: the claude-mem observer dir is special-cased, else the last path segment. */
function projectName(cwd?: string): string {
    if (!cwd) {
        return t("sessions.group.noProject");
    }
    if (String(cwd).indexOf(".claude-mem") >= 0) {
        return t("sessions.group.memoryObserver");
    }
    const parts = String(cwd)
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/);
    return parts[parts.length - 1] || String(cwd);
}
/** Collapsible group header (caret + label + count) for project/branch grouping. */
function collapsibleGroupHeader(
    key: string,
    label: string,
    count: number,
    expanded: boolean,
): HTMLDivElement {
    const gh = document.createElement("div");
    gh.className = "groupHeader collapsible" + (expanded ? " expanded" : "");
    const cv = svgIcon("chevron");
    cv.classList.add("groupCaret");
    cv.style.transform = expanded ? "rotate(0deg)" : "rotate(-90deg)";
    cv.style.transition = "transform 150ms ease";
    gh.appendChild(cv);
    const gl = document.createElement("span");
    gl.className = "glabel";
    gl.textContent = label;
    gl.title = label;
    const gc = document.createElement("span");
    gc.className = "gcount";
    gc.textContent = String(count);
    gh.appendChild(gl);
    gh.appendChild(gc);
    gh.onclick = () => toggleGroup(key);
    return gh;
}
export function renderAccount(profile?: AccountProfile | null): void {
    const el = document.getElementById("accountFooter");
    if (!el) {
        return;
    }
    el.textContent = "";
    if (profile && (profile.name || profile.email)) {
        if (profile.picture) {
            const img = document.createElement("img");
            img.setAttribute("src", profile.picture);
            img.alt = "";
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
        nm.className = "acc-name";
        nm.textContent = profile.name || profile.email || "";
        txt.appendChild(nm);
        if (profile.name && profile.email) {
            const sub = document.createElement("div");
            sub.className = "acc-sub";
            sub.textContent = profile.email;
            txt.appendChild(sub);
        }
        el.appendChild(txt);
        const out = document.createElement("span");
        out.className = "acc-out";
        out.title = "Sair";
        out.setAttribute("role", "button");
        out.setAttribute("aria-label", "Sair");
        out.appendChild(svgIcon("logout"));
        out.onclick = (e) => {
            e.stopPropagation();
            postMessage({ type: "account-logout" });
        };
        el.appendChild(out);
        el.onclick = null;
    } else {
        const ic = document.createElement("div");
        ic.className = "acc-ico";
        ic.textContent = "↪";
        el.appendChild(ic);
        const txt = document.createElement("div");
        txt.className = "acc-text";
        const nm = document.createElement("div");
        nm.className = "acc-name";
        nm.textContent = "Entrar na Sufficit";
        txt.appendChild(nm);
        el.appendChild(txt);
        el.onclick = () => postMessage({ type: "account-login" });
    }
}
export function renderSessions(): void {
    sessionsList.textContent = "";
    updateFilterButtonState();
    if (!sessionsLoaded) {
        sessionsList.appendChild(
            sessionsPlaceholder("loading", t("sessions.loading"), t("sessions.loading.detail")),
        );
        return;
    }
    const visible = sortSessions(
        sessions.filter(
            (s) => (!s.archived || showArchived) && matchesSearch(s) && matchesSessionFilters(s),
        ),
    );
    if (visible.length === 0) {
        sessionsList.appendChild(
            sessionsPlaceholder("empty", t("sessions.empty"), t("sessions.empty.detail")),
        );
        return;
    }
    // Subagents (parentId pointing at a visible session) render nested under
    // their parent — not as top-level rows — so the list stays a tidy tree.
    const byId = new Map(visible.map((s) => [s.sessionId, s]));
    const childrenOf = (id: string): SessionListItem[] =>
        visible.filter((s) => s.parentId && s.parentId === id);
    const isChild = (s: SessionListItem): boolean => !!s.parentId && byId.has(s.parentId);
    const top = visible.filter((s) => !isChild(s));
    // Append a row and, when expanded, its subagent children (recursively).
    const appendTree = (s: SessionListItem, depth: number): void => {
        const kids = childrenOf(s.sessionId);
        sessionsList.appendChild(renderSessionItem(s, depth, kids.length));
        if (kids.length && isParentExpanded(s.sessionId)) {
            for (const k of kids) {
                appendTree(k, depth + 1);
            }
        }
    };
    // Collapse a list of sessions into conversation lineages: the latest session
    // of each lineage is the head; its older sessions nest below in descending
    // order (accordion, collapsed by default). Reused by "Conversation" and the
    // inner level of "Project + Conversation".
    const byRecent = (a: SessionListItem, b: SessionListItem): number =>
        (b.updatedAt ? new Date(b.updatedAt).getTime() : 0) -
        (a.updatedAt ? new Date(a.updatedAt).getTime() : 0);
    const conversationKeyOf = (s: SessionListItem): string =>
        `${String(s.backend || "")}:${String(s.lineageId || s.sessionId)}`;
    const appendLineages = (items: SessionListItem[]): void => {
        const lin = new Map();
        for (const s of items) {
            const k = conversationKeyOf(s);
            if (!lin.has(k)) {
                lin.set(k, []);
            }
            lin.get(k).push(s);
        }
        const lineages = [...lin.values()].map((arr) => [...arr].sort(byRecent));
        lineages.sort((a, b) => byRecent(a[0], b[0]));
        for (const arr of lineages) {
            const head = arr[0];
            const older = arr.slice(1);
            sessionsList.appendChild(renderSessionItem(head, 0, older.length));
            if (older.length && isParentExpanded(head.sessionId)) {
                for (const o of older) {
                    sessionsList.appendChild(renderSessionItem(o, 1, 0));
                }
            }
        }
    };
    const pinned = sortSessions(top.filter((s) => s.pinned)).sort(
        (a, b) => (a.pinIndex || 0) - (b.pinIndex || 0),
    );
    const rest = sortSessions(top.filter((s) => !s.pinned));
    if (pinned.length) {
        sessionsList.appendChild(groupHeader("Pinned", pinned.length));
        for (const s of pinned) {
            appendTree(s, 0);
        }
    }
    if (sessionGroupBy === "none") {
        for (const s of rest) {
            appendTree(s, 0);
        }
    } else if (sessionGroupBy === "time") {
        let lastBucket: string | null = null;
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
        const keyOf = (s: SessionListItem): string =>
            byBranch ? s.gitBranch || "__nobranch__" : s.cwd || "__noproject__";
        const labelOf = (s: SessionListItem): string =>
            byBranch ? s.gitBranch || t("sessions.group.noBranch") : projectName(s.cwd);
        const groups = new Map<
            string,
            { label: string; items: SessionListItem[]; recent: number }
        >();
        for (const s of rest) {
            const k = keyOf(s);
            if (!groups.has(k)) {
                groups.set(k, { label: labelOf(s), items: [], recent: 0 });
            }
            const g = groups.get(k)!;
            g.items.push(s);
            const ts = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
            if (ts > g.recent) {
                g.recent = ts;
            }
        }
        const keys = [...groups.keys()].sort(
            (a, b) => groups.get(b)!.recent - groups.get(a)!.recent,
        );
        for (const k of keys) {
            const g = groups.get(k)!;
            const expanded = expandedGroups.has(k);
            // In the combined mode the count is the number of CONVERSATIONS, not sessions.
            const count = useLineages
                ? new Set(g.items.map((s) => conversationKeyOf(s))).size
                : g.items.length;
            sessionsList.appendChild(collapsibleGroupHeader(k, g.label, count, expanded));
            if (expanded) {
                if (useLineages) {
                    appendLineages(g.items);
                } else {
                    for (const s of g.items) {
                        appendTree(s, 0);
                    }
                }
            }
        }
    }
}

function sessionsPlaceholder(kind: "loading" | "empty", title: string, detail: string) {
    const box = document.createElement("div");
    box.className = "sessionsPlaceholder " + kind;
    box.setAttribute("aria-live", "polite");
    const icon = document.createElement("div");
    icon.className = "sessionsPlaceholderIcon";
    if (kind === "loading") {
        const sp = document.createElement("span");
        sp.className = "spinner";
        icon.appendChild(sp);
    } else {
        icon.appendChild(svgIcon("chat"));
    }
    const text = document.createElement("div");
    text.className = "sessionsPlaceholderText";
    const head = document.createElement("div");
    head.className = "sessionsPlaceholderTitle";
    head.textContent = title;
    const sub = document.createElement("div");
    sub.className = "sessionsPlaceholderDetail";
    sub.textContent = detail;
    text.appendChild(head);
    text.appendChild(sub);
    box.appendChild(icon);
    box.appendChild(text);
    return box;
}
registerSessionBridge({ renderSessions, backendLabel });
