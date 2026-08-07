// Footer status bar + context-usage popover.
import { saved, saveState } from "./vscode";
import { statusbar, ctxMenu } from "./dom";
import { usageColor } from "./format";
import { svgIcon } from "./icons";
import { mergeQuotaSnapshot, resolveStatusbarData } from "../quotaSnapshot";
import type { AdapterQuotaSnapshot, UsageQuotaWindow } from "../../adapters/types";
import { renderUsagePopover } from "./statusbarUsagePopover";
import { renderQuotaPopover } from "./statusbarQuotaPopover";
import type { LastTurn, StatusbarData, UsageSnapshot } from "./statusbarTypes";
export type { LastTurn, StatusbarData, UsageSnapshot } from "./statusbarTypes";
let lastUsage: UsageSnapshot | null = null;
let lastStatusData: StatusbarData = {};
let quotaLoading = false;
let lastTurn: LastTurn = {};
const quotaByBackend = new Map<string, AdapterQuotaSnapshot>();
for (const quota of Array.isArray(saved.adapterQuotas) ? saved.adapterQuotas : []) {
    if (quota && typeof quota.backend === "string" && Array.isArray(quota.windows)) {
        quotaByBackend.set(quota.backend, quota);
    }
}
export let sessionCostUsd = 0; // accumulated cost across the session (when reported)

function activeQuotaWindows(quota?: AdapterQuotaSnapshot): UsageQuotaWindow[] {
    const now = Date.now();
    return (quota?.windows || []).filter(
        (window) =>
            Number.isFinite(window.usedPercent) && (!window.resetsAt || window.resetsAt > now),
    );
}

function currentQuotaSnapshot(): AdapterQuotaSnapshot {
    const current = String(lastStatusData.backend || "");
    const quota = quotaByBackend.get(current);
    return quota
        ? { ...quota, windows: activeQuotaWindows(quota) }
        : {
              backend: current as AdapterQuotaSnapshot["backend"],
              displayName: String(lastStatusData.backendName || current),
              windows: [] as UsageQuotaWindow[],
              updatedAt: Date.now(),
              state: "unavailable",
              message: "This adapter has not reported usage limits yet.",
          };
}

function primaryQuota(): { quota: AdapterQuotaSnapshot; window: UsageQuotaWindow } | null {
    const current = currentQuotaSnapshot();
    if (!current.windows.length) {
        return null;
    }
    const indexed = current.windows.map((window, index) => ({ window, index }));
    indexed.sort((a, b) => {
        const am = a.window.windowMinutes ?? Number.POSITIVE_INFINITY;
        const bm = b.window.windowMinutes ?? Number.POSITIVE_INFINITY;
        return am - bm || a.index - b.index;
    });
    return { quota: current, window: indexed[0].window };
}

function meter(
    percent: number | undefined,
    label: string,
    onOpen: (anchor: HTMLButtonElement) => void,
    className = "",
    displayedPercent = percent,
    colorPercent = percent,
): HTMLButtonElement {
    const hasValue = Number.isFinite(percent);
    const numericPercent = Number(percent ?? 0);
    const pct = hasValue ? Math.max(0, Math.min(100, Math.round(numericPercent))) : 0;
    const risk = Number.isFinite(colorPercent)
        ? Math.max(0, Math.min(100, Math.round(Number(colorPercent))))
        : pct;
    const col = hasValue ? usageColor(risk) : "var(--vscode-descriptionForeground, currentColor)";
    const button = document.createElement("button");
    button.className = "tokenMeter" + (className ? " " + className : "");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-haspopup", "dialog");
    const ring = document.createElement("span");
    ring.className = "tmRing";
    ring.style.background = hasValue
        ? "conic-gradient(" +
          col +
          " " +
          pct +
          "%, var(--vscode-input-background, rgba(128,128,128,0.3)) 0)"
        : "var(--vscode-input-background, rgba(128,128,128,0.3))";
    button.appendChild(ring);
    const shown = Number.isFinite(displayedPercent)
        ? Math.max(0, Math.round(Number(displayedPercent)))
        : pct;
    button.appendChild(document.createTextNode(hasValue ? shown + "%" : "—"));
    button.classList.toggle("quotaEmpty", !hasValue);
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        onOpen(button);
    });
    button.addEventListener("mouseenter", () => onOpen(button));
    button.addEventListener("focus", () => onOpen(button));
    return button;
}

export function renderStatusbar(data?: StatusbarData): void {
    lastStatusData = resolveStatusbarData(lastStatusData, data) as StatusbarData;
    data = lastStatusData;
    const quotaPopoverOpen =
        ctxMenu.style.display === "block" && !!ctxMenu.querySelector(".quotaPop");
    statusbar.textContent = "";
    const seg = (iconName: string | null, text: string, title = ""): HTMLSpanElement => {
        const s = document.createElement("span");
        s.className = "seg";
        if (title) s.title = title;
        if (iconName) s.appendChild(svgIcon(iconName));
        s.appendChild(document.createTextNode(text));
        return s;
    };
    if (data.cwd) {
        const base = String(data.cwd).split("/").filter(Boolean).pop() || data.cwd;
        statusbar.appendChild(seg("terminal", base, data.cwd));
    }
    statusbar.appendChild(
        seg(
            null,
            String(data.backend ?? "") +
                (data.permission && data.permission !== "default" ? " · " + data.permission : ""),
        ),
    );
    if (data.reasoning && data.reasoning !== "default")
        statusbar.appendChild(seg(null, "effort: " + data.reasoning));
    const snapshot = currentQuotaSnapshot(),
        quota = primaryQuota();
    const health = Number.isFinite(snapshot.healthPercent)
        ? Math.max(0, Math.min(100, Number(snapshot.healthPercent)))
        : null;
    const usage = lastUsage;
    const hasContext = !!usage?.contextWindow;
    const sp = document.createElement("span");
    sp.className = "grow";
    statusbar.appendChild(sp);
    const pct = health ?? quota?.window.usedPercent;
    const remaining = quota?.window.remainingPercent;
    const label =
        health != null
            ? "Preset health " +
              Math.round(health) +
              "%" +
              (snapshot.state === "stale" ? " — cached data; live refresh failed" : "") +
              " — hover, focus, or click for details"
            : quota
              ? "Adapter usage " +
                Math.round(Number(pct)) +
                "% used" +
                (Number.isFinite(remaining)
                    ? ", " + Math.round(Number(remaining)) + "% available"
                    : "") +
                (snapshot.state === "stale" ? " — cached data; live refresh failed" : "") +
                " — hover, focus, or click for limits"
              : quotaLoading
                ? "Loading adapter usage limits"
                : "Adapter usage unavailable — click for details";
    const quotaMeter = meter(
        pct,
        label,
        openQuotaPopover,
        "quotaMeter",
        pct,
        health != null ? 100 - health : pct,
    );
    quotaMeter.setAttribute("aria-busy", String(quotaLoading));
    statusbar.appendChild(quotaMeter);
    if (hasContext) {
        const pct = Math.round(((usage?.inputTokens || 0) / (usage?.contextWindow || 1)) * 100);
        const exceeded = pct >= 100;
        const contextLabel = exceeded
            ? "Context window exceeded: " +
              pct +
              "% used — request must be compacted before sending"
            : "Context window " + pct + "% used — click for details";
        const contextMeter = meter(
            Math.min(100, pct),
            contextLabel,
            openUsagePopover,
            "contextMeter",
            pct,
        );
        contextMeter.classList.toggle("contextExceeded", exceeded);
        statusbar.appendChild(contextMeter);
    }
    if (quotaPopoverOpen) {
        openQuotaPopover(quotaMeter);
    }
}

export function openQuotaPopover(anchor: HTMLElement): void {
    renderQuotaPopover(anchor, currentQuotaSnapshot(), primaryQuota(), quotaLoading, () => {
        setQuotaLoading(true);
        openQuotaPopover(anchor);
    });
}

export function openUsagePopover(anchor: HTMLElement): void {
    renderUsagePopover(anchor, lastUsage, { lastTurn, sessionCostUsd });
}

export function setLastUsage(v: UsageSnapshot | null): void {
    lastUsage = v;
}
export function setLastQuota(v: AdapterQuotaSnapshot | null): void {
    if (!v || typeof v.backend !== "string" || !Array.isArray(v.windows)) {
        return;
    }
    quotaByBackend.set(v.backend, mergeQuotaSnapshot(quotaByBackend.get(v.backend), v));
    saveState({ adapterQuotas: [...quotaByBackend.values()] });
}
export function setQuotaLoading(value: boolean): void {
    quotaLoading = !!value;
}
export function setLastTurn(v: LastTurn): void {
    lastTurn = v;
}
export function setSessionCostUsd(v: number): void {
    sessionCostUsd = v;
}
