// Menus, context menus, tooltips, toast. Side-effect listeners run on import.
import { vscode } from "./vscode";
import { ctxMenu, tipEl } from "./dom";
import { svgIcon } from "./icons";
import { lastAutoScroll } from "./scroll";
import { setPendingSessionSwitch } from "./state";

const CLI_BACKENDS: any = { claude: 1, codex: 1, copilot: 1 };

export function openChoiceMenu(anchorEl, options, current, onPick, opts) {
    opts = opts || {};
    ctxMenu.textContent = "";
    const wantSearch = opts.search || options.length >= 9;

    const list = document.createElement("div"); list.className = "menuList";
    const renderRows = (filter) => {
        list.textContent = "";
        const q = (filter || "").toLowerCase();
        let lastGroup = null; let shown = 0;
        for (const o of options) {
            if (q && !(o.label + " " + (o.detail || "")).toLowerCase().includes(q)) continue;
            if (o.group && o.group !== lastGroup) {
                lastGroup = o.group;
                const gh = document.createElement("div"); gh.className = "menuGroup"; gh.textContent = o.group;
                list.appendChild(gh);
            }
            const mi = document.createElement("div"); mi.className = "mi";
            const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = o.value === current ? "✓" : "";
            const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = o.label;
            mi.appendChild(tick); mi.appendChild(lbl);
            if (o.detail) { const d = document.createElement("span"); d.className = "midetail"; d.textContent = o.detail; mi.appendChild(d); }
            if (o.title) mi.title = o.title;
            if (o.actions && o.actions.length) {
                const acts = document.createElement("span"); acts.className = "miacts";
                for (const act of o.actions) {
                    const btn = document.createElement("button");
                    btn.className = "miact" + (act.on ? " on" : "");
                    btn.title = act.title; btn.innerHTML = act.icon;
                    btn.addEventListener("click", (e) => { e.stopPropagation(); act.onClick(); });
                    acts.appendChild(btn);
                }
                mi.appendChild(acts);
            }
            mi.addEventListener("click", () => onPick(o.value));
            list.appendChild(mi);
            shown++;
        }
        if (!shown) { const e = document.createElement("div"); e.className = "mi"; e.style.opacity = "0.6"; e.textContent = "no matches"; list.appendChild(e); }
    };

    if (wantSearch) {
        const box = document.createElement("input"); box.className = "menuSearch"; box.type = "text"; box.placeholder = "Search…";
        box.addEventListener("input", () => renderRows(box.value));
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCtx(); });
        ctxMenu.appendChild(box);
        setTimeout(() => box.focus(), 0);
    }
    if (opts.refreshAction) {
        const rb = document.createElement("div"); rb.className = "mi";
        const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = "↻";
        const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = opts.refreshAction.label || "Refresh";
        rb.appendChild(tick); rb.appendChild(lbl);
        if (opts.refreshAction.detail) { const d = document.createElement("span"); d.className = "midetail"; d.textContent = opts.refreshAction.detail; rb.appendChild(d); }
        rb.addEventListener("click", () => { hideCtx(); opts.refreshAction.onClick(); });
        ctxMenu.appendChild(rb);
    }
    if (opts.switchAction) {
        const sb = document.createElement("div"); sb.className = "mi";
        const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = "⇄";
        const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = opts.switchAction.label || "Switch backend";
        sb.appendChild(tick); sb.appendChild(lbl);
        if (opts.switchAction.detail) { const d = document.createElement("span"); d.className = "midetail"; d.textContent = opts.switchAction.detail; sb.appendChild(d); }
        sb.addEventListener("click", () => { hideCtx(); opts.switchAction.onClick(); });
        ctxMenu.appendChild(sb);
    }
    renderRows("");
    ctxMenu.appendChild(list);

    // Optional free-form entry row: lets the user type a value not present
    // in the list (used by the model picker when discovery returned none).
    if (opts.manualEntry) {
        const me = opts.manualEntry;
        const wrap = document.createElement("div"); wrap.className = "menuManual";
        const input = document.createElement("input");
        input.className = "menuSearch"; input.type = "text";
        input.placeholder = me.placeholder || me.label || "Type a value…";
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); const v = input.value; hideCtx(); me.onSubmit(v); }
            else if (e.key === "Escape") { hideCtx(); }
        });
        const hint = document.createElement("div"); hint.className = "menuGroup"; hint.textContent = me.label || "Manual entry";
        wrap.appendChild(hint); wrap.appendChild(input);
        ctxMenu.appendChild(wrap);
        if (!options.length) { setTimeout(() => input.focus(), 0); }
    }

    ctxMenu.style.display = "block";
    const r = anchorEl.getBoundingClientRect();
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";
    ctxMenu.style.top = Math.max(4, r.top - h - 4) + "px";
}

// Transient toast (bottom-center, auto-dismiss). Reused for copy feedback.
const TOAST_CHECK = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 3.5 6 11 2.5 7.5l1-1L6 9l6.5-6.5 1 1Z"/></svg>';
let toastTimer = null;
export function showToast(message) {
    const el = document.getElementById("toast");
    if (!el) { return; }
    el.innerHTML = TOAST_CHECK + "<span></span>";
    el.querySelector("span").textContent = message;
    el.classList.add("show");
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// Themed tooltip engine: replaces the unstyled native title= bubble with a
// theme-aware, animated one. Reads the element's title attribute (so no
// markup changes), suppresses the native tooltip while shown, and restores
// it after. Works on hover AND keyboard focus (a11y).
let tipTarget = null;
export function placeTip(target) {
    const r = target.getBoundingClientRect();
    const tr = tipEl.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top = r.top - tr.height - 8;
    if (top < 8) { top = r.bottom + 8; tipEl.classList.add("below"); }
    else { tipEl.classList.remove("below"); }
    tipEl.style.left = left + "px";
    tipEl.style.top = top + "px";
}
export function showTip(target) {
    const text = target.getAttribute("title");
    if (!text || !text.trim()) { return; }
    if (tipTarget) { hideTip(); }
    tipTarget = target;
    target.setAttribute("data-otitle", text);
    target.removeAttribute("title");        // suppress the native bubble
    tipEl.textContent = text;
    tipEl.classList.add("show");
    placeTip(target);                       // measure after content set
    placeTip(target);                       // 2nd pass: size known now
}
export function hideTip() {
    tipEl.classList.remove("show");
    if (tipTarget && tipTarget.getAttribute("data-otitle") != null) {
        tipTarget.setAttribute("title", tipTarget.getAttribute("data-otitle"));
        tipTarget.removeAttribute("data-otitle");
    }
    tipTarget = null;
}
document.addEventListener("mouseover", (e) => {
    const t = e.target.closest && e.target.closest("[title]");
    if (t && t !== tipTarget) { showTip(t); }
});
document.addEventListener("mouseout", (e) => {
    if (tipTarget && !tipTarget.contains(e.relatedTarget)) { hideTip(); }
});
document.addEventListener("focusin", (e) => {
    const t = e.target.closest && e.target.closest("[title]");
    if (t) { showTip(t); }
});
document.addEventListener("focusout", () => hideTip());
// Never leave a stuck tip: hide on scroll/click/escape.
window.addEventListener("scroll", () => { if (tipTarget) { hideTip(); } }, true);
document.addEventListener("click", () => { if (tipTarget) { hideTip(); } }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tipTarget) { hideTip(); } });

export function actionsFor(s) {
    const cli = !!CLI_BACKENDS[s.backend];
    const list = [];
    if (cli) {
        list.push({ id: "open", icon: "terminal", label: "Resume in terminal" });
    }
    list.push({ id: "rename", icon: "rename", label: "Rename" });
    if (cli) {
        list.push({ id: "watch", icon: "eye", label: "Watch live (read-only)" });
    }
    list.push({ id: "switchAgent", icon: "arrow-swap", label: "Switch model →" });
    if (s.pinned) {
        list.push({ id: "pinUp", icon: "up", label: "Move pin up" });
        list.push({ id: "pinDown", icon: "down", label: "Move pin down" });
        list.push({ id: "unpin", icon: "pin", label: "Unpin" });
    } else {
        list.push({ id: "pin", icon: "pin", label: "Pin to top" });
    }
    list.push(s.archived
        ? { id: "unarchive", icon: "unarchive", label: "Unarchive" }
        : { id: "archive", icon: "archive", label: "Archive" });
    list.push({ id: "delete", icon: "trash", label: "Delete permanently", danger: true });
    return list;
}

export function runAction(s, action) {
    if (action === "switchAgent") {
        // Don't close the menu position context; request the candidate
        // backends, then reopen as a submenu anchored at the same spot.
        const rect = ctxMenu.getBoundingClientRect();
        setPendingSessionSwitch({ session: s, x: rect.left, y: rect.top });
        hideCtx();
        vscode.postMessage({ type: "session-list-backends", sessionId: s.sessionId, backend: s.backend });
        return;
    }
    hideCtx();
    vscode.postMessage({ type: "session-action", action, sessionId: s.sessionId, backend: s.backend });
}

export function hideCtx() { ctxMenu.style.display = "none"; }

export function showCtx(ev, s) {
    ctxMenu.textContent = "";
    ctxMenu.classList.remove("sessionFiltersMenu");
    for (const a of actionsFor(s)) {
        if (a.danger) {
            const sep = document.createElement("div"); sep.className = "sep"; ctxMenu.appendChild(sep);
        }
        const mi = document.createElement("div");
        mi.className = "mi" + (a.danger ? " danger" : "");
        const ic = svgIcon(a.icon); ic.classList.add("miIcon");
        mi.appendChild(ic);
        mi.appendChild(document.createTextNode(a.label));
        mi.addEventListener("click", () => runAction(s, a.id));
        ctxMenu.appendChild(mi);
    }
    ctxMenu.style.display = "block";
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
    ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
}

document.addEventListener("click", hideCtx);
// Close on page scroll, but NOT when scrolling inside the menu's own list,
// and NOT for programmatic auto-scroll of the log (new messages must not
// close an open menu like the send-mode picker).
document.addEventListener("scroll", (e) => {
    if (ctxMenu.contains(e.target)) { return; }
    if (Date.now() - lastAutoScroll < 200) { return; }
    hideCtx();
}, true);

export function showFileMenu(ev, path) {
    ev.preventDefault(); ev.stopPropagation();
    ctxMenu.textContent = "";
    const add = (icon, label, type) => {
        const mi = document.createElement("div"); mi.className = "mi";
        const ic = svgIcon(icon); ic.classList.add("miIcon");
        mi.appendChild(ic); mi.appendChild(document.createTextNode(label));
        mi.addEventListener("click", () => { hideCtx(); vscode.postMessage({ type, path }); });
        ctxMenu.appendChild(mi);
    };
    add("diff", "Open diff", "file-diff");
    add("file", "Open file", "open-file");
    ctxMenu.style.display = "block";
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
    ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
}

