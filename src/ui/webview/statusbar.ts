// Footer status bar + context-usage popover.
import { vscode } from "./vscode";
import { statusbar, ctxMenu, input } from "./dom";
import { activeModel, commands } from "./state";
import { fmtTokens, usageColor } from "./format";
import { modelLabel } from "./models";
import { svgIcon } from "./icons";
import { hideCtx } from "./menus";
import { send } from "./composer";

let lastUsage = null, lastStatusData = {};
let lastTurn = {};            // { costUsd, durationMs } from the last turn-end
export let sessionCostUsd = 0;       // accumulated cost across the session (when reported)
export function renderStatusbar(data) {
    lastStatusData = data || lastStatusData;
    data = lastStatusData;
    statusbar.textContent = "";
    const seg = (iconName, text, title) => {
        const s = document.createElement("span"); s.className = "seg"; if (title) s.title = title;
        if (iconName) s.appendChild(svgIcon(iconName));
        s.appendChild(document.createTextNode(text));
        return s;
    };
    if (data.cwd) {
        const base = String(data.cwd).split("/").filter(Boolean).pop() || data.cwd;
        statusbar.appendChild(seg("terminal", base, data.cwd));
    }
    statusbar.appendChild(seg(null, data.backend + (data.permission && data.permission !== "default" ? " · " + data.permission : "")));
    if (data.reasoning && data.reasoning !== "default") statusbar.appendChild(seg(null, "effort: " + data.reasoning));
    if (lastUsage && lastUsage.contextWindow) {
        const pct = Math.min(100, Math.round((lastUsage.inputTokens || 0) / lastUsage.contextWindow * 100));
        const col = usageColor(pct);
        const m = document.createElement("button"); m.className = "tokenMeter"; m.title = "Context window — click for details";
        m.setAttribute("aria-label", "Context window " + pct + "% used — click for details");
        const ring = document.createElement("span"); ring.className = "tmRing"; ring.style.background =
            "conic-gradient(" + col + " " + pct + "%, var(--vscode-input-background, rgba(128,128,128,0.3)) 0)";
        m.appendChild(ring);
        m.appendChild(document.createTextNode(pct + "%"));
        m.addEventListener("click", (e) => { e.stopPropagation(); openUsagePopover(m); });
        const sp = document.createElement("span"); sp.className = "grow"; statusbar.appendChild(sp);
        statusbar.appendChild(m);
    }
}
export function openUsagePopover(anchor) {
    const u = lastUsage; if (!u) { return; }
    const win = u.contextWindow || 0, used = u.inputTokens || 0, out = u.outputTokens || 0, cache = u.cacheRead || 0;
    const fresh = Math.max(0, used - cache);
    const free = Math.max(0, win - used);
    const pct = win ? Math.round(used / win * 100) : 0;
    const cachePct = used ? Math.round(cache / used * 100) : 0;
    const col = usageColor(pct);
    ctxMenu.textContent = "";
    const box = document.createElement("div"); box.className = "usagePop";
    // One key/value line. opts: { sub, dot, note } — dot draws a legend swatch,
    // note is a dim suffix (e.g. a percentage), sub indents a breakdown row.
    const row = (label, value, opts) => {
        const o = opts || {};
        const r = document.createElement("div"); r.className = "uRow" + (o.sub ? " uSub" : "");
        const a = document.createElement("span"); a.className = "uLbl";
        if (o.dot) { const d = document.createElement("span"); d.className = "uDot"; d.style.background = o.dot; a.appendChild(d); }
        a.appendChild(document.createTextNode(label));
        const b = document.createElement("span"); b.className = "uVal"; b.textContent = value;
        if (o.note != null) { const n = document.createElement("span"); n.className = "uNote"; n.textContent = o.note; b.appendChild(n); }
        r.appendChild(a); r.appendChild(b); return r;
    };
    const group = (t) => { const g = document.createElement("div"); g.className = "uGroup"; g.textContent = t; box.appendChild(g); };

    // Header: title + model on the left, big colored % on the right.
    const headRow = document.createElement("div"); headRow.className = "uHeadRow";
    const htx = document.createElement("div"); htx.className = "uHeadTxt";
    const h = document.createElement("div"); h.className = "uHead"; h.textContent = "Context Window"; htx.appendChild(h);
    if (activeModel) { const sm = document.createElement("div"); sm.className = "uModel"; sm.textContent = modelLabel(activeModel); htx.appendChild(sm); }
    const big = document.createElement("div"); big.className = "uPct"; big.textContent = pct + "%"; big.style.color = col;
    headRow.appendChild(htx); headRow.appendChild(big); box.appendChild(headRow);

    // Bar: within the used portion, cache is a translucent sub-segment and
    // fresh tokens the solid one; the remainder is the free track.
    const bar = document.createElement("div"); bar.className = "uBar";
    const fill = document.createElement("div"); fill.className = "uFill"; fill.style.width = pct + "%";
    const cfrac = used ? (cache / used * 100) : 0;
    fill.style.background = "linear-gradient(90deg, color-mix(in srgb, " + col + " 42%, transparent) 0 " + cfrac + "%, " + col + " " + cfrac + "% 100%)";
    bar.appendChild(fill); box.appendChild(bar);

    group("Context");
    box.appendChild(row("Used", fmtTokens(used), { dot: col, note: pct + "%" }));
    box.appendChild(row("Free", fmtTokens(free), { dot: "var(--vscode-input-background, rgba(128,128,128,0.3))", note: (100 - pct) + "%" }));
    box.appendChild(row("Window", fmtTokens(win)));

    group("Last turn");
    box.appendChild(row("Input (prompt)", fmtTokens(used)));
    if (cache) {
        box.appendChild(row("Cached", fmtTokens(cache), { sub: true, note: cachePct + "% hit" }));
        box.appendChild(row("Fresh", fmtTokens(fresh), { sub: true }));
    }
    box.appendChild(row("Output", fmtTokens(out)));
    box.appendChild(row("Total tokens", fmtTokens(used + out)));
    if (lastTurn.costUsd) { box.appendChild(row("Cost", "$" + lastTurn.costUsd.toFixed(4))); }
    if (lastTurn.durationMs) { box.appendChild(row("Time", (lastTurn.durationMs / 1000).toFixed(1) + "s")); }
    if (sessionCostUsd > 0) { box.appendChild(row("Session cost", "$" + sessionCostUsd.toFixed(4))); }

    // Inspect (analysis): open the compact model context and the literal last
    // request as read-only editor tabs. The full transcript stays on screen.
    const insp = document.createElement("div"); insp.className = "uInspect";
    const mkInspect = (label, target, title) => {
        const b = document.createElement("button"); b.className = "uInspectBtn"; b.textContent = label; b.title = title;
        b.addEventListener("click", () => { hideCtx(); vscode.postMessage({ type: "inspect", target: target }); });
        return b;
    };
    insp.appendChild(mkInspect("Model context", "context", "Open exactly what the model receives now (compact)"));
    insp.appendChild(mkInspect("Last request", "request", "Open the literal last request body sent to the gateway"));
    box.appendChild(insp);

    // Only offer Compact when the active backend advertises it (claude/codex/
    // copilot). The native API backends have no /compact — they auto-window
    // history — so the button would otherwise send a literal "/compact" text.
    if (commands.some((c) => c.name === "compact")) {
        const btn = document.createElement("button"); btn.className = "uCompact"; btn.textContent = "Compact Conversation";
        btn.addEventListener("click", () => { hideCtx(); input.value = "/compact"; send(); });
        box.appendChild(btn);
    }
    ctxMenu.appendChild(box);
    ctxMenu.style.display = "block";
    const r = anchor.getBoundingClientRect(); const w = ctxMenu.offsetWidth, ht = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4)) + "px";
    ctxMenu.style.top = Math.max(4, r.top - ht - 6) + "px";
}

export function setLastUsage(v) { lastUsage = v; }
export function setLastTurn(v) { lastTurn = v; }
export function setSessionCostUsd(v) { sessionCostUsd = v; }
