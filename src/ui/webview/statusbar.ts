// Footer status bar + context-usage popover.
import { vscode, saved, saveState } from "./vscode";
import { statusbar, ctxMenu, input } from "./dom";
import { activeModel, commands } from "./state";
import { fmtTokens, usageColor } from "./format";
import { modelLabel } from "./models";
import { svgIcon } from "./icons";
import { hideCtx } from "./menus";
import { send } from "./composer";
import { mergeQuotaSnapshot, resolveStatusbarData } from "../quotaSnapshot";

let lastUsage = null;
let lastStatusData: any = {};
let quotaLoading = false;
let lastTurn: any = {};            // { costUsd, durationMs } from the last turn-end
const quotaByBackend = new Map();
for (const quota of Array.isArray(saved.adapterQuotas) ? saved.adapterQuotas : []) {
    if (quota && typeof quota.backend === "string" && Array.isArray(quota.windows)) {
        quotaByBackend.set(quota.backend, quota);
    }
}
export let sessionCostUsd = 0;       // accumulated cost across the session (when reported)

function activeQuotaWindows(quota) {
    const now = Date.now();
    return (quota?.windows || []).filter((window) =>
        Number.isFinite(window.usedPercent) && (!window.resetsAt || window.resetsAt > now),
    );
}

function currentQuotaSnapshot() {
    const current = String(lastStatusData.backend || "");
    const quota = quotaByBackend.get(current);
    return quota
        ? { ...quota, windows: activeQuotaWindows(quota) }
        : {
            backend: current,
            displayName: lastStatusData.backendName || current,
            windows: [],
            state: "unavailable",
            message: "This adapter has not reported usage limits yet.",
        };
}

function primaryQuota() {
    const current = currentQuotaSnapshot();
    if (!current.windows.length) { return null; }
    const indexed = current.windows.map((window, index) => ({ window, index }));
    indexed.sort((a, b) => {
        const am = Number.isFinite(a.window.windowMinutes) ? a.window.windowMinutes : Number.POSITIVE_INFINITY;
        const bm = Number.isFinite(b.window.windowMinutes) ? b.window.windowMinutes : Number.POSITIVE_INFINITY;
        return am - bm || a.index - b.index;
    });
    return { quota: current, window: indexed[0].window };
}

function meter(percent, label, onOpen, className = "", displayedPercent = percent, colorPercent = percent) {
    const hasValue = Number.isFinite(percent);
    const pct = hasValue ? Math.max(0, Math.min(100, Math.round(percent))) : 0;
    const risk = Number.isFinite(colorPercent) ? Math.max(0, Math.min(100, Math.round(colorPercent))) : pct;
    const col = hasValue ? usageColor(risk) : "var(--vscode-descriptionForeground, currentColor)";
    const button = document.createElement("button");
    button.className = "tokenMeter" + (className ? " " + className : "");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-haspopup", "dialog");
    const ring = document.createElement("span");
    ring.className = "tmRing";
    ring.style.background = hasValue
        ? "conic-gradient(" + col + " " + pct + "%, var(--vscode-input-background, rgba(128,128,128,0.3)) 0)"
        : "var(--vscode-input-background, rgba(128,128,128,0.3))";
    button.appendChild(ring);
    const shown = Number.isFinite(displayedPercent) ? Math.max(0, Math.round(displayedPercent)) : pct;
    button.appendChild(document.createTextNode(hasValue ? shown + "%" : "—"));
    button.classList.toggle("quotaEmpty", !hasValue);
    button.addEventListener("click", (event) => { event.stopPropagation(); onOpen(button); });
    button.addEventListener("mouseenter", () => onOpen(button));
    button.addEventListener("focus", () => onOpen(button));
    return button;
}

export function renderStatusbar(data?: any) {
    lastStatusData = resolveStatusbarData(lastStatusData, data);
    data = lastStatusData;
    const quotaPopoverOpen = ctxMenu.style.display === "block" && !!ctxMenu.querySelector(".quotaPop");
    statusbar.textContent = "";
    const seg = (iconName, text, title = "") => {
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
    const snapshot = currentQuotaSnapshot(), quota = primaryQuota();
    const health = Number.isFinite(snapshot.healthPercent) ? Math.max(0, Math.min(100, Number(snapshot.healthPercent))) : null;
    const hasContext = !!(lastUsage && lastUsage.contextWindow);
    const sp = document.createElement("span"); sp.className = "grow"; statusbar.appendChild(sp);
    const pct = health ?? quota?.window.usedPercent;
    const remaining = quota?.window.remainingPercent;
    const label = health != null
        ? "Preset health " + Math.round(health) + "%" + (snapshot.state === "stale" ? " — cached data; live refresh failed" : "") + " — hover, focus, or click for details"
        : quota
        ? "Adapter usage " + Math.round(pct) + "% used" +
            (Number.isFinite(remaining) ? ", " + Math.round(remaining) + "% available" : "") +
            (snapshot.state === "stale" ? " — cached data; live refresh failed" : "") +
            " — hover, focus, or click for limits"
        : quotaLoading ? "Loading adapter usage limits" : "Adapter usage unavailable — click for details";
    const quotaMeter = meter(pct, label, openQuotaPopover, "quotaMeter", pct, health != null ? 100 - health : pct);
    quotaMeter.setAttribute("aria-busy", String(quotaLoading));
    statusbar.appendChild(quotaMeter);
    if (hasContext) {
        const pct = Math.round((lastUsage.inputTokens || 0) / lastUsage.contextWindow * 100);
        const exceeded = pct >= 100;
        const contextLabel = exceeded
            ? "Context window exceeded: " + pct + "% used — request must be compacted before sending"
            : "Context window " + pct + "% used — click for details";
        const contextMeter = meter(Math.min(100, pct), contextLabel, openUsagePopover, "contextMeter", pct);
        contextMeter.classList.toggle("contextExceeded", exceeded);
        statusbar.appendChild(contextMeter);
    }
    if (quotaPopoverOpen) { openQuotaPopover(quotaMeter); }
}

function positionPopover(anchor) {
    const r = anchor.getBoundingClientRect(); const w = ctxMenu.offsetWidth, ht = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4)) + "px";
    ctxMenu.style.top = Math.max(4, r.top - ht - 6) + "px";
}

function humanize(value) {
    return String(value || "usage")
        .replace(/[:_-]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function durationLabel(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) { return ""; }
    if (minutes % 10080 === 0) { const value = minutes / 10080; return value + " week" + (value === 1 ? "" : "s"); }
    if (minutes % 1440 === 0) { const value = minutes / 1440; return value + " day" + (value === 1 ? "" : "s"); }
    if (minutes % 60 === 0) { const value = minutes / 60; return value + " hour" + (value === 1 ? "" : "s"); }
    return Math.round(minutes) + " minutes";
}

function windowLabel(window) {
    return window.label || durationLabel(window.windowMinutes) || humanize(window.id);
}

function resetLabel(resetsAt) {
    if (!resetsAt) { return "Reset time unavailable"; }
    const remaining = resetsAt - Date.now();
    if (remaining <= 0) { return "Reset due"; }
    const minutes = Math.max(1, Math.round(remaining / 60000));
    if (minutes < 60) { return "Resets in " + minutes + "m"; }
    const hours = Math.floor(minutes / 60), restMinutes = minutes % 60;
    if (hours < 24) { return "Resets in " + hours + "h" + (restMinutes ? " " + restMinutes + "m" : ""); }
    const days = Math.floor(hours / 24), restHours = hours % 24;
    return "Resets in " + days + "d" + (restHours ? " " + restHours + "h" : "");
}

function backendLabel(backend) {
    return humanize(backend);
}

export function openQuotaPopover(anchor) {
    const quota = currentQuotaSnapshot();
    const featured = primaryQuota();
    const health = Number.isFinite(quota.healthPercent) ? Math.max(0, Math.min(100, Number(quota.healthPercent))) : null;
    ctxMenu.textContent = "";
    ctxMenu.classList.remove("sessionFiltersMenu");
    const box = document.createElement("div"); box.className = "usagePop quotaPop";
    box.setAttribute("role", "dialog"); box.setAttribute("aria-label", health != null ? "Preset health" : "Adapter usage limits");

    const headRow = document.createElement("div"); headRow.className = "uHeadRow";
    const htx = document.createElement("div"); htx.className = "uHeadTxt";
    const h = document.createElement("div"); h.className = "uHead"; h.textContent = health != null ? "Preset health" : "Usage limits"; htx.appendChild(h);
    const sub = document.createElement("div"); sub.className = "uModel"; sub.textContent = quota.displayName || backendLabel(quota.backend); htx.appendChild(sub);
    const big = document.createElement("div"); big.className = "uPct";
    big.textContent = health != null ? Math.round(health) + "%" : featured ? Math.round(featured.window.usedPercent) + "%" : "—";
    if (health != null) { big.style.color = usageColor(100 - health); }
    else if (featured) { big.style.color = usageColor(featured.window.usedPercent); }
    headRow.appendChild(htx); headRow.appendChild(big); box.appendChild(headRow);

    if (health == null) {
    const provider = document.createElement("section"); provider.className = "qProvider";
    const providerHead = document.createElement("div"); providerHead.className = "qProviderHead";
    const name = document.createElement("span"); name.className = "qProviderName"; name.textContent = quota.displayName || backendLabel(quota.backend);
    const meta = document.createElement("span"); meta.className = "qProviderMeta";
    meta.textContent = [quota.plan, quota.limitName].filter(Boolean).join(" · ") || (quota.windows.length ? "" : "No data yet");
    providerHead.appendChild(name); if (meta.textContent) { providerHead.appendChild(meta); }
    provider.appendChild(providerHead);

    if (quota.state === "stale" || (quota.state === "ready" && quota.message)) {
        const warning = document.createElement("div"); warning.className = "qWarning";
        warning.setAttribute("role", "status");
        warning.textContent = quota.message || "Live refresh failed. These usage values may be out of date.";
        provider.appendChild(warning);
    }
    if (!quota.windows.length) {
        const empty = document.createElement("div"); empty.className = "qEmptyState";
        empty.textContent = quotaLoading ? "Reading this adapter's usage…" : (quota.message || "This adapter has not reported usage limits yet.");
        provider.appendChild(empty);
    }
    for (const window of quota.windows) {
            const pct = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
            const color = usageColor(pct);
            const row = document.createElement("div"); row.className = "qWindow";
            const top = document.createElement("div"); top.className = "qWindowTop";
            const label = document.createElement("span"); label.className = "qWindowLabel"; label.textContent = windowLabel(window);
            const available = window.remainingPercent;
            const value = document.createElement("span"); value.className = "qWindowValue";
            value.textContent = Math.round(pct) + "% used" + (Number.isFinite(available) ? " · " + Math.round(available) + "% available" : "");
            top.appendChild(label); top.appendChild(value); row.appendChild(top);
            const bar = document.createElement("div"); bar.className = "qBar";
            bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", (quota.displayName || backendLabel(quota.backend)) + " " + windowLabel(window));
            bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(Math.round(pct)));
            const fill = document.createElement("div"); fill.className = "qFill"; fill.style.width = pct + "%"; fill.style.background = color;
            bar.appendChild(fill); row.appendChild(bar);
            const detail = document.createElement("div"); detail.className = "qWindowDetail";
            detail.textContent = [window.detail || "", resetLabel(window.resetsAt), window.status ? humanize(window.status) : ""].filter(Boolean).join(" · ");
            row.appendChild(detail); provider.appendChild(row);
    }
    box.appendChild(provider);
    } else if (quota.state === "stale" || quota.message) {
        const warning = document.createElement("div"); warning.className = "qWarning"; warning.setAttribute("role", "status");
        warning.textContent = quota.message || "Live refresh failed. This health value may be out of date."; box.appendChild(warning);
    }
    const foot = document.createElement("div"); foot.className = "qFoot";
    const footText = document.createElement("span");
    footText.textContent = quotaLoading
        ? health != null ? "Refreshing preset health…" : "Refreshing this adapter…"
        : quota.state === "stale" ? "Cached adapter data." : health != null ? "Sufficit preset health." : "Adapter-owned usage data.";
    const refresh = document.createElement("button"); refresh.className = "qRefresh"; refresh.type = "button"; refresh.textContent = quotaLoading ? "Refreshing…" : "Refresh"; refresh.disabled = quotaLoading;
    refresh.addEventListener("click", (event) => {
        event.stopPropagation();
        setQuotaLoading(true); openQuotaPopover(anchor);
        vscode.postMessage({ type: "refresh-quotas" });
    });
    foot.appendChild(footText); foot.appendChild(refresh); box.appendChild(foot);
    ctxMenu.appendChild(box);
    ctxMenu.style.display = "block";
    positionPopover(anchor);
}
export function openUsagePopover(anchor) {
    const u = lastUsage; if (!u) { return; }
    const win = u.contextWindow || 0, used = u.inputTokens || 0, out = u.outputTokens || 0, cache = u.cacheRead || 0;
    const total = u.totalTokens || (used + out);
    const reasoning = u.reasoningTokens || 0;
    const fresh = Math.max(0, used - cache);
    const free = Math.max(0, win - used);
    const pct = win ? Math.round(used / win * 100) : 0;
    const freePct = Math.max(0, 100 - pct);
    const cachePct = used ? Math.round(cache / used * 100) : 0;
    const col = usageColor(pct);
    ctxMenu.textContent = "";
    ctxMenu.classList.remove("sessionFiltersMenu");
    const box = document.createElement("div"); box.className = "usagePop";
    // One key/value line. opts: { sub, dot, note } — dot draws a legend swatch,
    // note is a dim suffix (e.g. a percentage), sub indents a breakdown row.
    const row = (label, value, opts: any = {}) => {
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
    const ms = (value) => value ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "s" : "";
    const count = (value) => String(Math.round(Number(value || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

    // Header: title + model on the left, big colored % on the right.
    const headRow = document.createElement("div"); headRow.className = "uHeadRow";
    const htx = document.createElement("div"); htx.className = "uHeadTxt";
    const h = document.createElement("div"); h.className = "uHead"; h.textContent = "Context Window"; htx.appendChild(h);
    const shownModel = u.modelLabel || (u.model ? modelLabel(u.model) : "") || (activeModel ? modelLabel(activeModel) : "");
    if (shownModel) { const sm = document.createElement("div"); sm.className = "uModel"; sm.textContent = shownModel; htx.appendChild(sm); }
    const big = document.createElement("div"); big.className = "uPct"; big.textContent = pct + "%"; big.style.color = col;
    headRow.appendChild(htx); headRow.appendChild(big); box.appendChild(headRow);

    // Bar: within the used portion, cache is a translucent sub-segment and
    // fresh tokens the solid one; the remainder is the free track.
    const bar = document.createElement("div"); bar.className = "uBar";
    const fill = document.createElement("div"); fill.className = "uFill"; fill.style.width = Math.min(100, pct) + "%";
    const cfrac = used ? (cache / used * 100) : 0;
    fill.style.background = "linear-gradient(90deg, color-mix(in srgb, " + col + " 42%, transparent) 0 " + cfrac + "%, " + col + " " + cfrac + "% 100%)";
    bar.appendChild(fill); box.appendChild(bar);

    group("Context");
    if (pct >= 100) {
        const warning = document.createElement("div");
        warning.className = "uWarning";
        warning.setAttribute("role", "status");
        warning.textContent = "Over the reported context limit. Symposium will compact before sending or block the request if it still cannot fit.";
        box.appendChild(warning);
    }
    if (u.estimated) { box.appendChild(row("Source", "local estimate")); }
    box.appendChild(row("Used", fmtTokens(used), { dot: col, note: pct + "%" }));
    box.appendChild(row("Free", fmtTokens(free), { dot: "var(--vscode-input-background, rgba(128,128,128,0.3))", note: freePct + "%" }));
    box.appendChild(row("Window", fmtTokens(win)));
    if (u.providerKey || u.providerType || u.model || u.requestedModel || u.attempts || u.fallbackAttempts) {
        const provider = u.providerKey || u.providerType;
        const effective = provider && u.model ? provider + " / " + u.model : (u.model || provider);
        if (effective) { box.appendChild(row("Effective", effective)); }
        if (u.providerType && u.providerType !== u.providerKey) { box.appendChild(row("Provider type", u.providerType)); }
        if (u.requestedModel && u.requestedModel !== u.model) { box.appendChild(row("Requested", u.requestedModel)); }
        if (u.attempts) { box.appendChild(row("Attempts", String(u.attempts))); }
        if (u.fallbackAttempts) { box.appendChild(row("Fallbacks", String(u.fallbackAttempts))); }
        const cmp = u.compression;
        if (cmp?.savedChars) {
            box.appendChild(row("Compression", count(cmp.savedChars) + " chars saved"));
            if (cmp.originalChars && cmp.compressedChars) {
                box.appendChild(row("Chars", count(cmp.originalChars) + " -> " + count(cmp.compressedChars), { sub: true }));
            }
            if (cmp.truncatedMessages) { box.appendChild(row("Truncated", String(cmp.truncatedMessages), { sub: true })); }
            if (cmp.removedMessages) { box.appendChild(row("Removed", String(cmp.removedMessages), { sub: true })); }
            if (cmp.prunedToolCalls) { box.appendChild(row("Pruned tools", String(cmp.prunedToolCalls), { sub: true })); }
            if (cmp.foldedToolResults) { box.appendChild(row("Folded results", String(cmp.foldedToolResults), { sub: true })); }
        }
    }

    group("Last turn");
    box.appendChild(row(u.estimated ? "Input estimate" : "Input (prompt)", fmtTokens(used)));
    if (u.requestChars) { box.appendChild(row("Request chars", count(u.requestChars), { sub: true })); }
    if (u.requestMessageCount) { box.appendChild(row("Messages", String(u.requestMessageCount), { sub: true })); }
    if (u.requestToolCount) { box.appendChild(row("Tools", String(u.requestToolCount), { sub: true })); }
    if (cache) {
        box.appendChild(row("Cached", fmtTokens(cache), { sub: true, note: cachePct + "% hit" }));
        box.appendChild(row("Fresh", fmtTokens(fresh), { sub: true }));
    }
    box.appendChild(row("Output", fmtTokens(out)));
    if (reasoning) { box.appendChild(row("Reasoning", fmtTokens(reasoning), { sub: true })); }
    box.appendChild(row("Total tokens", fmtTokens(total)));
    if (lastTurn.costUsd) { box.appendChild(row("Cost", "$" + lastTurn.costUsd.toFixed(4))); }
    if (sessionCostUsd > 0) { box.appendChild(row("Session cost", "$" + sessionCostUsd.toFixed(4))); }

    if (lastTurn.durationMs || u.durationMs || u.ttfbMs || u.firstDeltaMs) {
        group("Runtime");
        if (lastTurn.durationMs) { box.appendChild(row("Turn time", ms(lastTurn.durationMs))); }
        if (u.durationMs) { box.appendChild(row("Model call", ms(u.durationMs))); }
        if (u.ttfbMs) { box.appendChild(row("TTFB", ms(u.ttfbMs))); }
        if (u.firstDeltaMs) { box.appendChild(row("First delta", ms(u.firstDeltaMs))); }
    }

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

    // Only offer Compact when the active backend advertises it. Native API
    // backends can intercept /compact locally; others may omit the command.
    if (commands.some((c) => c.name === "compact")) {
        const btn = document.createElement("button"); btn.className = "uCompact"; btn.textContent = "Compact Conversation";
        btn.addEventListener("click", () => { hideCtx(); input.value = "/compact"; send(); });
        box.appendChild(btn);
    }
    ctxMenu.appendChild(box);
    ctxMenu.style.display = "block";
    positionPopover(anchor);
}

export function setLastUsage(v) { lastUsage = v; }
export function setLastQuota(v) {
    if (!v || typeof v.backend !== "string" || !Array.isArray(v.windows)) { return; }
    quotaByBackend.set(v.backend, mergeQuotaSnapshot(quotaByBackend.get(v.backend), v));
    saveState({ adapterQuotas: [...quotaByBackend.values()] });
}
export function setQuotaLoading(value) { quotaLoading = !!value; }
export function setLastTurn(v) { lastTurn = v; }
export function setSessionCostUsd(v) { sessionCostUsd = v; }
