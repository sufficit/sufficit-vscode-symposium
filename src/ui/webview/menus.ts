// Menus, context menus, tooltips, toast. Side-effect listeners run on import.
import { postMessage } from "./vscode";
import { ctxMenu, tipEl } from "./dom";
import { svgIcon } from "./icons";
import { t } from "./i18n";
import { lastAutoScroll } from "./scroll";
import { setPendingSessionSwitch } from "./state";
import { copyText } from "./markdownCode";
import type { SessionActionKind } from "../../protocol/chat";
import type { SessionListItem } from "./types";

const CLI_BACKENDS: Record<string, boolean> = { claude: true, codex: true, copilot: true };

export { openChoiceMenu } from "./choiceMenu";
export type { ChoiceMenuAction, ChoiceMenuOption } from "./choiceMenu";

// Transient toast (bottom-center, auto-dismiss). Reused for copy feedback.
const TOAST_CHECK =
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 3.5 6 11 2.5 7.5l1-1L6 9l6.5-6.5 1 1Z"/></svg>';
const TOAST_ERROR =
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm.75 3v5h-1.5V4h1.5Zm0 6.5v1.5h-1.5v-1.5h1.5Z"/></svg>';
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastText = "";

function markToastCopied(el: HTMLElement): void {
    el.classList.add("copied");
    el.setAttribute("aria-label", "Error copied to clipboard");
    setTimeout(() => {
        el.classList.remove("copied");
        if (el.classList.contains("error")) {
            el.setAttribute("aria-label", "Error notification. Click to copy its text.");
        }
    }, 1200);
}

function copyToastError(): void {
    const el = document.getElementById("toast");
    if (!el || !el.classList.contains("error") || !toastText) {
        return;
    }
    copyText(toastText, () => markToastCopied(el));
}

document.addEventListener("click", (event) => {
    const toast = (event.target as HTMLElement).closest?.(
        "#toast.error.copyable",
    ) as HTMLElement | null;
    if (toast) {
        copyToastError();
    }
});
document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
        return;
    }
    const toast = (event.target as HTMLElement).closest?.(
        "#toast.error.copyable",
    ) as HTMLElement | null;
    if (!toast) {
        return;
    }
    event.preventDefault();
    copyToastError();
});

export function showToast(message: string, kind: "info" | "error" = "info"): void {
    const el = document.getElementById("toast");
    if (!el) {
        return;
    }
    const isError = kind === "error";
    toastText = isError ? message : "";
    el.innerHTML = (kind === "error" ? TOAST_ERROR : TOAST_CHECK) + "<span></span>";
    const textElement = el.querySelector<HTMLElement>("span");
    if (textElement) textElement.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.toggle("copyable", isError);
    el.classList.remove("copied");
    el.tabIndex = isError ? 0 : -1;
    el.setAttribute("role", isError ? "button" : "status");
    el.setAttribute(
        "aria-label",
        isError ? "Error notification. Click to copy its text." : "Notification",
    );
    if (isError) {
        el.setAttribute("title", "Click to copy error");
    } else {
        el.removeAttribute("title");
    }
    el.classList.add("show");
    if (toastTimer) {
        clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// Themed tooltip engine: replaces the unstyled native title= bubble with a
// theme-aware, animated one. Reads the element's title attribute (so no
// markup changes), suppresses the native tooltip while shown, and restores
// it after. Works on hover AND keyboard focus (a11y).
let tipTarget: HTMLElement | null = null;
export function placeTip(target: HTMLElement): void {
    const padding = 8;
    const r = target.getBoundingClientRect();
    const tr = tipEl.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(padding, Math.min(left, window.innerWidth - tr.width - padding));
    let top = r.top - tr.height - 8;
    if (top < 8) {
        top = r.bottom + 8;
        tipEl.classList.add("below");
    } else {
        tipEl.classList.remove("below");
    }
    top = Math.max(padding, Math.min(top, window.innerHeight - tr.height - padding));
    tipEl.style.left = left + "px";
    tipEl.style.top = top + "px";
}
export function showTip(target: HTMLElement): void {
    const text = target.getAttribute("title");
    if (!text || !text.trim()) {
        return;
    }
    if (tipTarget) {
        hideTip();
    }
    tipTarget = target;
    target.setAttribute("data-otitle", text);
    target.removeAttribute("title"); // suppress the native bubble
    tipEl.textContent = text;
    tipEl.classList.add("show");
    placeTip(target); // measure after content set
    placeTip(target); // 2nd pass: size known now
}
export function hideTip(): void {
    tipEl.classList.remove("show");
    if (tipTarget && tipTarget.getAttribute("data-otitle") != null) {
        tipTarget.setAttribute("title", tipTarget.getAttribute("data-otitle") ?? "");
        tipTarget.removeAttribute("data-otitle");
    }
    tipTarget = null;
}
document.addEventListener("mouseover", (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.("[title]");
    if (t && t !== tipTarget) {
        showTip(t as HTMLElement);
    }
});
document.addEventListener("mouseout", (e) => {
    if (tipTarget && !tipTarget.contains(e.relatedTarget as Node | null)) {
        hideTip();
    }
});
document.addEventListener("focusin", (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.("[title]");
    if (t) {
        showTip(t as HTMLElement);
    }
});
document.addEventListener("focusout", () => hideTip());
// Never leave a stuck tip: hide on scroll/click/escape.
window.addEventListener(
    "scroll",
    () => {
        if (tipTarget) {
            hideTip();
        }
    },
    true,
);
document.addEventListener(
    "click",
    () => {
        if (tipTarget) {
            hideTip();
        }
    },
    true,
);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tipTarget) {
        hideTip();
    }
});

interface SessionMenuAction {
    id: SessionActionKind | "switchAgent";
    icon: string;
    label: string;
    danger?: boolean;
}
export function actionsFor(s: SessionListItem): SessionMenuAction[] {
    const cli = !!CLI_BACKENDS[s.backend];
    const list: SessionMenuAction[] = [];
    if (cli) {
        list.push({ id: "open", icon: "terminal", label: "Resume in terminal" });
    }
    list.push({ id: "openEditor", icon: "go-to-file", label: "Open in editor tab" });
    list.push({ id: "rename", icon: "rename", label: "Rename" });
    if (cli) {
        list.push({ id: "watch", icon: "eye", label: "Watch live (read-only)" });
    }
    list.push({ id: "switchAgent", icon: "arrow-swap", label: "Switch adapter →" });
    if (s.pinned) {
        list.push({ id: "pinUp", icon: "up", label: "Move pin up" });
        list.push({ id: "pinDown", icon: "down", label: "Move pin down" });
        list.push({ id: "unpin", icon: "pin", label: "Unpin" });
    } else {
        list.push({ id: "pin", icon: "pin", label: "Pin to top" });
    }
    list.push(
        s.archived
            ? { id: "unarchive", icon: "unarchive", label: "Unarchive" }
            : { id: "archive", icon: "archive", label: "Archive" },
    );
    list.push({ id: "delete", icon: "trash", label: "Delete permanently", danger: true });
    return list;
}

export function runAction(s: SessionListItem, action: SessionActionKind | "switchAgent"): void {
    if (action === "switchAgent") {
        // Don't close the menu position context; request the candidate
        // backends, then reopen as a submenu anchored at the same spot.
        const rect = ctxMenu.getBoundingClientRect();
        setPendingSessionSwitch({ session: s, x: rect.left, y: rect.top });
        hideCtx();
        postMessage({
            type: "session-list-backends",
            sessionId: s.sessionId,
            backend: s.backend,
        });
        return;
    }
    hideCtx();
    postMessage({
        type: "session-action",
        action,
        sessionId: s.sessionId,
        backend: s.backend,
    });
}

export function hideCtx(): void {
    ctxMenu.style.display = "none";
}

export function showCtx(ev: MouseEvent, s: SessionListItem): void {
    ctxMenu.textContent = "";
    ctxMenu.classList.remove("sessionFiltersMenu");
    for (const a of actionsFor(s)) {
        if (a.danger) {
            const sep = document.createElement("div");
            sep.className = "sep";
            ctxMenu.appendChild(sep);
        }
        const mi = document.createElement("div");
        mi.className = "mi" + (a.danger ? " danger" : "");
        const ic = svgIcon(a.icon);
        ic.classList.add("miIcon");
        mi.appendChild(ic);
        mi.appendChild(document.createTextNode(a.label));
        mi.addEventListener("click", () => runAction(s, a.id));
        ctxMenu.appendChild(mi);
    }
    ctxMenu.style.display = "block";
    const w = ctxMenu.offsetWidth,
        h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
    ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
}

document.addEventListener("click", hideCtx);
// Close on page scroll, but NOT when scrolling inside the menu's own list,
// and NOT for programmatic auto-scroll of the log (new messages must not
// close an open menu like the send-mode picker).
document.addEventListener(
    "scroll",
    (e) => {
        if (e.target instanceof Node && ctxMenu.contains(e.target)) {
            return;
        }
        if (Date.now() - lastAutoScroll < 200) {
            return;
        }
        hideCtx();
    },
    true,
);

export function showFileMenu(ev: MouseEvent, path: string): void {
    ev.preventDefault();
    ev.stopPropagation();
    ctxMenu.textContent = "";
    const add = (icon: string, label: string, type: "file-diff" | "open-file"): void => {
        const mi = document.createElement("div");
        mi.className = "mi";
        const ic = svgIcon(icon);
        ic.classList.add("miIcon");
        mi.appendChild(ic);
        mi.appendChild(document.createTextNode(label));
        mi.addEventListener("click", () => {
            hideCtx();
            postMessage({ type, path });
        });
        ctxMenu.appendChild(mi);
    };
    add("diff", "Open diff", "file-diff");
    add("file", "Open file", "open-file");
    ctxMenu.style.display = "block";
    const w = ctxMenu.offsetWidth,
        h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
    ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
}

// Right-click on a tool row's verb: same in-webview menu style as showFileMenu
// (not a native VS Code quickpick — that renders at the top of the window,
// far from the row the user actually clicked).
export function showToolMenu(ev: MouseEvent, toolName: string, toolPath?: string): void {
    ev.preventDefault();
    ev.stopPropagation();
    ctxMenu.textContent = "";
    const add = (icon: string, label: string, onClick: () => void): void => {
        const mi = document.createElement("div");
        mi.className = "mi";
        const ic = svgIcon(icon);
        ic.classList.add("miIcon");
        mi.appendChild(ic);
        mi.appendChild(document.createTextNode(label));
        mi.addEventListener("click", () => {
            hideCtx();
            onClick();
        });
        ctxMenu.appendChild(mi);
    };
    add("mdfile", "Show manual", () => postMessage({ type: "show-tool-manual", toolName }));
    if (toolPath) {
        add("file", "Open file", () => postMessage({ type: "open-file", path: toolPath }));
        add("diff", "Show diff", () => postMessage({ type: "file-diff", path: toolPath }));
    }
    ctxMenu.style.display = "block";
    const w = ctxMenu.offsetWidth,
        h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
    ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
}

export function showLinkMenu(
    ev: MouseEvent,
    address: string,
    open: () => void,
    kind: "link" | "file",
): void {
    ev.preventDefault();
    ev.stopPropagation();
    hideTip();
    ctxMenu.textContent = "";
    ctxMenu.classList.remove("sessionFiltersMenu");
    ctxMenu.setAttribute("role", "menu");
    ctxMenu.setAttribute("aria-label", t("chat.link.menu"));
    const add = (icon: string, label: string, action: () => void): HTMLButtonElement => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "mi";
        item.setAttribute("role", "menuitem");
        const graphic = svgIcon(icon);
        graphic.classList.add("miIcon");
        item.appendChild(graphic);
        item.appendChild(document.createTextNode(label));
        item.addEventListener("click", () => {
            hideCtx();
            action();
        });
        ctxMenu.appendChild(item);
        return item;
    };
    const first = add(kind === "file" ? "file" : "globe", t(`chat.link.open.${kind}`), open);
    add("copy", t("chat.link.copyAddress"), () =>
        copyText(address, () => showToast(t("chat.link.copied"))),
    );
    ctxMenu.style.display = "block";
    const rect =
        ev.currentTarget instanceof HTMLElement ? ev.currentTarget.getBoundingClientRect() : null;
    const x = ev.clientX || rect?.left || 4;
    const y = ev.clientY || rect?.bottom || 4;
    const width = ctxMenu.offsetWidth;
    const height = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - width - 4)) + "px";
    ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - height - 4)) + "px";
    first.focus({ preventScroll: true });
}
