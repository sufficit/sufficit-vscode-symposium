// Adapter quota and preset-health popover.
import { postMessage } from "./vscode";
import { ctxMenu } from "./dom";
import { usageColor } from "./format";
import type { AdapterQuotaSnapshot, UsageQuotaWindow } from "../../adapters/types";

export type FeaturedQuota = { quota: AdapterQuotaSnapshot; window: UsageQuotaWindow } | null;

function positionPopover(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = ctxMenu.offsetWidth;
    const height = ctxMenu.offsetHeight;
    ctxMenu.style.left =
        Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4)) + "px";
    ctxMenu.style.top = Math.max(4, rect.top - height - 6) + "px";
}

function humanize(value: unknown): string {
    return String(value || "usage")
        .replace(/[:_-]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function durationLabel(minutes?: number): string {
    if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "";
    if (minutes % 10080 === 0) {
        const value = minutes / 10080;
        return value + " week" + (value === 1 ? "" : "s");
    }
    if (minutes % 1440 === 0) {
        const value = minutes / 1440;
        return value + " day" + (value === 1 ? "" : "s");
    }
    if (minutes % 60 === 0) {
        const value = minutes / 60;
        return value + " hour" + (value === 1 ? "" : "s");
    }
    return Math.round(minutes) + " minutes";
}

function windowLabel(value: UsageQuotaWindow): string {
    return value.label || durationLabel(value.windowMinutes) || humanize(value.id);
}

function resetLabel(resetsAt?: number): string {
    if (!resetsAt) return "Reset time unavailable";
    const remaining = resetsAt - Date.now();
    if (remaining <= 0) return "Reset due";
    const minutes = Math.max(1, Math.round(remaining / 60000));
    if (minutes < 60) return "Resets in " + minutes + "m";
    const hours = Math.floor(minutes / 60),
        restMinutes = minutes % 60;
    if (hours < 24)
        return "Resets in " + hours + "h" + (restMinutes ? " " + restMinutes + "m" : "");
    const days = Math.floor(hours / 24),
        restHours = hours % 24;
    return "Resets in " + days + "d" + (restHours ? " " + restHours + "h" : "");
}

function backendLabel(backend: string): string {
    return humanize(backend);
}

export function renderQuotaPopover(
    anchor: HTMLElement,
    quota: AdapterQuotaSnapshot,
    featured: FeaturedQuota,
    quotaLoading: boolean,
    onRefresh: () => void,
): void {
    const health = Number.isFinite(quota.healthPercent)
        ? Math.max(0, Math.min(100, Number(quota.healthPercent)))
        : null;
    ctxMenu.textContent = "";
    ctxMenu.classList.remove("sessionFiltersMenu");
    const box = document.createElement("div");
    box.className = "usagePop quotaPop";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", health != null ? "Preset health" : "Adapter usage limits");

    const headRow = document.createElement("div");
    headRow.className = "uHeadRow";
    const htx = document.createElement("div");
    htx.className = "uHeadTxt";
    const h = document.createElement("div");
    h.className = "uHead";
    h.textContent = health != null ? "Preset health" : "Usage limits";
    htx.appendChild(h);
    const sub = document.createElement("div");
    sub.className = "uModel";
    sub.textContent = quota.displayName || backendLabel(quota.backend);
    htx.appendChild(sub);
    const big = document.createElement("div");
    big.className = "uPct";
    big.textContent =
        health != null
            ? Math.round(health) + "%"
            : featured
              ? Math.round(featured.window.usedPercent) + "%"
              : "—";
    if (health != null) {
        big.style.color = usageColor(100 - health);
    } else if (featured) {
        big.style.color = usageColor(featured.window.usedPercent);
    }
    headRow.appendChild(htx);
    headRow.appendChild(big);
    box.appendChild(headRow);

    if (health == null) {
        const provider = document.createElement("section");
        provider.className = "qProvider";
        const providerHead = document.createElement("div");
        providerHead.className = "qProviderHead";
        const name = document.createElement("span");
        name.className = "qProviderName";
        name.textContent = quota.displayName || backendLabel(quota.backend);
        const meta = document.createElement("span");
        meta.className = "qProviderMeta";
        meta.textContent =
            [quota.plan, quota.limitName].filter(Boolean).join(" · ") ||
            (quota.windows.length ? "" : "No data yet");
        providerHead.appendChild(name);
        if (meta.textContent) {
            providerHead.appendChild(meta);
        }
        provider.appendChild(providerHead);

        if (quota.state === "stale" || (quota.state === "ready" && quota.message)) {
            const warning = document.createElement("div");
            warning.className = "qWarning";
            warning.setAttribute("role", "status");
            warning.textContent =
                quota.message || "Live refresh failed. These usage values may be out of date.";
            provider.appendChild(warning);
        }
        if (!quota.windows.length) {
            const empty = document.createElement("div");
            empty.className = "qEmptyState";
            empty.textContent = quotaLoading
                ? "Reading this adapter's usage…"
                : quota.message || "This adapter has not reported usage limits yet.";
            provider.appendChild(empty);
        }
        for (const window of quota.windows) {
            const pct = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
            const color = usageColor(pct);
            const row = document.createElement("div");
            row.className = "qWindow";
            const top = document.createElement("div");
            top.className = "qWindowTop";
            const label = document.createElement("span");
            label.className = "qWindowLabel";
            label.textContent = windowLabel(window);
            const available = window.remainingPercent;
            const value = document.createElement("span");
            value.className = "qWindowValue";
            value.textContent =
                Math.round(pct) +
                "% used" +
                (Number.isFinite(available)
                    ? " · " + Math.round(Number(available)) + "% available"
                    : "");
            top.appendChild(label);
            top.appendChild(value);
            row.appendChild(top);
            const bar = document.createElement("div");
            bar.className = "qBar";
            bar.setAttribute("role", "progressbar");
            bar.setAttribute(
                "aria-label",
                (quota.displayName || backendLabel(quota.backend)) + " " + windowLabel(window),
            );
            bar.setAttribute("aria-valuemin", "0");
            bar.setAttribute("aria-valuemax", "100");
            bar.setAttribute("aria-valuenow", String(Math.round(pct)));
            const fill = document.createElement("div");
            fill.className = "qFill";
            fill.style.width = pct + "%";
            fill.style.background = color;
            bar.appendChild(fill);
            row.appendChild(bar);
            const detail = document.createElement("div");
            detail.className = "qWindowDetail";
            detail.textContent = [
                window.detail || "",
                resetLabel(window.resetsAt),
                window.status ? humanize(window.status) : "",
            ]
                .filter(Boolean)
                .join(" · ");
            row.appendChild(detail);
            provider.appendChild(row);
        }
        box.appendChild(provider);
    } else if (quota.state === "stale" || quota.message) {
        const warning = document.createElement("div");
        warning.className = "qWarning";
        warning.setAttribute("role", "status");
        warning.textContent =
            quota.message || "Live refresh failed. This health value may be out of date.";
        box.appendChild(warning);
    }
    const foot = document.createElement("div");
    foot.className = "qFoot";
    const footText = document.createElement("span");
    footText.textContent = quotaLoading
        ? health != null
            ? "Refreshing preset health…"
            : "Refreshing this adapter…"
        : quota.state === "stale"
          ? "Cached adapter data."
          : health != null
            ? "Sufficit preset health."
            : "Adapter-owned usage data.";
    const refresh = document.createElement("button");
    refresh.className = "qRefresh";
    refresh.type = "button";
    refresh.textContent = quotaLoading ? "Refreshing…" : "Refresh";
    refresh.disabled = quotaLoading;
    refresh.addEventListener("click", (event) => {
        event.stopPropagation();
        onRefresh();
        postMessage({ type: "refresh-quotas" });
    });
    foot.appendChild(footText);
    foot.appendChild(refresh);
    box.appendChild(foot);
    ctxMenu.appendChild(box);
    ctxMenu.style.display = "block";
    positionPopover(anchor);
}
