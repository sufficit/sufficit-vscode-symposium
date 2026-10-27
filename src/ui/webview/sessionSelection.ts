// Multi-select mode for the sessions list + bulk actions (issue #57).
//
// Enter with the "Select" header button: rows gain checkboxes, clicks toggle
// membership instead of opening the chat, and a bulk bar offers Archive /
// Unarchive / Delete for the selection. Project/branch group headers expose
// the same actions for the whole group (hover "..." or right-click). Both
// paths post ONE `sessions-bulk` message; the extension host expands the
// cascades (subagents + edit branches), confirms once and runs the batch.
import { postMessage } from "./vscode";
import { sessionsList, ctxMenu, hideCtxMenu } from "./dom";
import { sessions } from "./state";
import { svgIcon } from "./icons";
import { refreshSessionList } from "./sessionBridge";
import type { SessionListItem } from "./types";

export type BulkSessionAction = "archive" | "unarchive" | "delete";

const keyOf = (s: { sessionId: string; backend: string }): string =>
    `${String(s.backend || "")}:${String(s.sessionId || "")}`;

let selecting = false;
const selected = new Set<string>();

// The browser/PWA shell routes messages through AHP, which does not handle
// sessions-bulk yet — drop the entry point there instead of a dead button.
const isPwa = !!(window as unknown as { __SYMPOSIUM__?: unknown }).__SYMPOSIUM__;
const selectBtn = document.getElementById("sessionSelectBtn");
if (isPwa) {
    selectBtn?.remove();
} else {
    selectBtn?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (selecting) {
            stopSelection();
        } else {
            startSelection();
        }
    });
}

export function selectionActive(): boolean {
    return selecting;
}

export function isSelected(s: SessionListItem): boolean {
    return selected.has(keyOf(s));
}

export function startSelection(): void {
    selecting = true;
    selected.clear();
    selectBtn?.classList.add("active");
    refreshSessionList();
    renderSelectionBar();
}

export function stopSelection(): void {
    selecting = false;
    selected.clear();
    selectBtn?.classList.remove("active");
    hideCtxMenu();
    refreshSessionList();
    renderSelectionBar();
}

export function toggleSelection(s: SessionListItem): void {
    const key = keyOf(s);
    if (selected.has(key)) {
        selected.delete(key);
    } else {
        selected.add(key);
    }
    refreshSessionList();
    renderSelectionBar();
}

function selectedItems(): { sessionId: string; backend: string }[] {
    return sessions
        .filter((s) => selected.has(keyOf(s)) && !s.deleting)
        .map((s) => ({ sessionId: s.sessionId, backend: s.backend }));
}

/** Posts one sessions-bulk message for the current checkbox selection. */
export function postSelectedBulkAction(action: BulkSessionAction): void {
    const items = selectedItems();
    if (!items.length) {
        return;
    }
    postMessage({ type: "sessions-bulk", action, items });
    stopSelection();
}

/** Posts one sessions-bulk message for an explicit batch (group menu). */
export function postBulkAction(action: BulkSessionAction, items: SessionListItem[]): void {
    const clean = items.filter((s) => !s.deleting);
    if (!clean.length) {
        return;
    }
    postMessage({
        type: "sessions-bulk",
        action,
        items: clean.map((s) => ({ sessionId: s.sessionId, backend: s.backend })),
    });
}

let bar: HTMLDivElement | null = null;

function barButton(label: string, onClick: () => void, danger = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bulkBtn" + (danger ? " danger" : "");
    btn.textContent = label;
    btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onClick();
    });
    return btn;
}

/** Shows/updates the bulk action bar above the sessions list. */
export function renderSelectionBar(): void {
    if (!bar) {
        bar = document.createElement("div");
        bar.id = "sessionsBulkBar";
        bar.setAttribute("role", "toolbar");
        bar.setAttribute("aria-label", "Bulk chat actions");
        sessionsList.parentElement?.insertBefore(bar, sessionsList);
    }
    bar.textContent = "";
    bar.classList.toggle("on", selecting);
    if (!selecting) {
        return;
    }
    const count = document.createElement("span");
    count.className = "bulkCount";
    count.textContent = `${selected.size} selected`;
    bar.appendChild(count);
    bar.appendChild(barButton("Archive", () => postSelectedBulkAction("archive")));
    bar.appendChild(barButton("Unarchive", () => postSelectedBulkAction("unarchive")));
    bar.appendChild(barButton("Delete", () => postSelectedBulkAction("delete"), true));
    bar.appendChild(barButton("Done", () => stopSelection()));
}

/** Context menu on a project/branch group header: bulk actions for the group. */
export function showGroupActionsMenu(
    ev: MouseEvent,
    items: SessionListItem[],
    label: string,
): void {
    ev.preventDefault();
    ev.stopPropagation();
    const clean = items.filter((s) => !s.deleting);
    if (!clean.length) {
        return;
    }
    ctxMenu.textContent = "";
    ctxMenu.classList.remove("sessionFiltersMenu");
    const head = document.createElement("div");
    head.className = "menuGroup";
    head.textContent = label;
    ctxMenu.appendChild(head);
    const add = (icon: string, text: string, action: BulkSessionAction, danger = false): void => {
        const mi = document.createElement("div");
        mi.className = "mi" + (danger ? " danger" : "");
        const ic = svgIcon(icon);
        ic.classList.add("miIcon");
        mi.appendChild(ic);
        mi.appendChild(document.createTextNode(text));
        mi.addEventListener("click", () => {
            hideCtxMenu();
            postBulkAction(action, clean);
        });
        ctxMenu.appendChild(mi);
    };
    add("archive", `Archive all (${clean.length})`, "archive");
    add("unarchive", `Unarchive all (${clean.length})`, "unarchive");
    const sep = document.createElement("div");
    sep.className = "sep";
    ctxMenu.appendChild(sep);
    add("trash", `Delete all (${clean.length})`, "delete", true);
    ctxMenu.style.display = "block";
    const w = ctxMenu.offsetWidth,
        h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
    ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selecting) {
        stopSelection();
    }
});
