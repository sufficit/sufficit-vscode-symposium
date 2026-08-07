// Detailed context/request usage popover.
import { postMessage } from "./vscode";
import { ctxMenu, input } from "./dom";
import { activeModel, commands } from "./state";
import { fmtTokens, usageColor } from "./format";
import { modelLabel } from "./models";
import { hideCtx } from "./menus";
import { send } from "./composer";
import type { LastTurn, UsageSnapshot } from "./statusbarTypes";

export interface UsagePopoverContext {
    lastTurn: LastTurn;
    sessionCostUsd: number;
}

interface UsageRowOptions {
    sub?: boolean;
    dot?: string;
    note?: string;
}

function positionPopover(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = ctxMenu.offsetWidth;
    const height = ctxMenu.offsetHeight;
    ctxMenu.style.left =
        Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4)) + "px";
    ctxMenu.style.top = Math.max(4, rect.top - height - 6) + "px";
}

export function renderUsagePopover(
    anchor: HTMLElement,
    u: UsageSnapshot | null,
    context: UsagePopoverContext,
): void {
    const { lastTurn, sessionCostUsd } = context;
    if (!u) {
        return;
    }
    const win = u.contextWindow || 0,
        used = u.inputTokens || 0,
        out = u.outputTokens || 0,
        cache = u.cacheRead || 0;
    const total = u.totalTokens || used + out;
    const reasoning = u.reasoningTokens || 0;
    const fresh = Math.max(0, used - cache);
    const free = Math.max(0, win - used);
    const pct = win ? Math.round((used / win) * 100) : 0;
    const freePct = Math.max(0, 100 - pct);
    const cachePct = used ? Math.round((cache / used) * 100) : 0;
    const col = usageColor(pct);
    ctxMenu.textContent = "";
    ctxMenu.classList.remove("sessionFiltersMenu");
    const box = document.createElement("div");
    box.className = "usagePop";
    // One key/value line. opts: { sub, dot, note } — dot draws a legend swatch,
    // note is a dim suffix (e.g. a percentage), sub indents a breakdown row.
    const row = (label: string, value: string, opts: UsageRowOptions = {}): HTMLDivElement => {
        const o = opts || {};
        const r = document.createElement("div");
        r.className = "uRow" + (o.sub ? " uSub" : "");
        const a = document.createElement("span");
        a.className = "uLbl";
        if (o.dot) {
            const d = document.createElement("span");
            d.className = "uDot";
            d.style.background = o.dot;
            a.appendChild(d);
        }
        a.appendChild(document.createTextNode(label));
        const b = document.createElement("span");
        b.className = "uVal";
        b.textContent = value;
        if (o.note != null) {
            const n = document.createElement("span");
            n.className = "uNote";
            n.textContent = o.note;
            b.appendChild(n);
        }
        r.appendChild(a);
        r.appendChild(b);
        return r;
    };
    const group = (t: string): void => {
        const g = document.createElement("div");
        g.className = "uGroup";
        g.textContent = t;
        box.appendChild(g);
    };
    const ms = (value: number): string =>
        value ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "s" : "";
    const count = (value: number): string =>
        String(Math.round(Number(value || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

    // Header: title + model on the left, big colored % on the right.
    const headRow = document.createElement("div");
    headRow.className = "uHeadRow";
    const htx = document.createElement("div");
    htx.className = "uHeadTxt";
    const h = document.createElement("div");
    h.className = "uHead";
    h.textContent = "Context Window";
    htx.appendChild(h);
    const shownModel =
        u.modelLabel ||
        (u.model ? modelLabel(u.model) : "") ||
        (activeModel ? modelLabel(activeModel) : "");
    if (shownModel) {
        const sm = document.createElement("div");
        sm.className = "uModel";
        sm.textContent = shownModel;
        htx.appendChild(sm);
    }
    const big = document.createElement("div");
    big.className = "uPct";
    big.textContent = pct + "%";
    big.style.color = col;
    headRow.appendChild(htx);
    headRow.appendChild(big);
    box.appendChild(headRow);

    // Bar: within the used portion, cache is a translucent sub-segment and
    // fresh tokens the solid one; the remainder is the free track.
    const bar = document.createElement("div");
    bar.className = "uBar";
    const fill = document.createElement("div");
    fill.className = "uFill";
    fill.style.width = Math.min(100, pct) + "%";
    const cfrac = used ? (cache / used) * 100 : 0;
    fill.style.background =
        "linear-gradient(90deg, color-mix(in srgb, " +
        col +
        " 42%, transparent) 0 " +
        cfrac +
        "%, " +
        col +
        " " +
        cfrac +
        "% 100%)";
    bar.appendChild(fill);
    box.appendChild(bar);

    group("Context");
    if (pct >= 100) {
        const warning = document.createElement("div");
        warning.className = "uWarning";
        warning.setAttribute("role", "status");
        warning.textContent =
            "Over the reported context limit. Symposium will compact before sending or block the request if it still cannot fit.";
        box.appendChild(warning);
    }
    if (u.estimated) {
        box.appendChild(row("Source", "local estimate"));
    }
    box.appendChild(row("Used", fmtTokens(used), { dot: col, note: pct + "%" }));
    box.appendChild(
        row("Free", fmtTokens(free), {
            dot: "var(--vscode-input-background, rgba(128,128,128,0.3))",
            note: freePct + "%",
        }),
    );
    box.appendChild(row("Window", fmtTokens(win)));
    if (
        u.providerKey ||
        u.providerType ||
        u.model ||
        u.requestedModel ||
        u.attempts ||
        u.fallbackAttempts
    ) {
        const provider = u.providerKey || u.providerType;
        const effective = provider && u.model ? provider + " / " + u.model : u.model || provider;
        if (effective) {
            box.appendChild(row("Effective", effective));
        }
        if (u.providerType && u.providerType !== u.providerKey) {
            box.appendChild(row("Provider type", u.providerType));
        }
        if (u.requestedModel && u.requestedModel !== u.model) {
            box.appendChild(row("Requested", u.requestedModel));
        }
        if (u.attempts) {
            box.appendChild(row("Attempts", String(u.attempts)));
        }
        if (u.fallbackAttempts) {
            box.appendChild(row("Fallbacks", String(u.fallbackAttempts)));
        }
        const cmp = u.compression;
        if (cmp?.savedChars) {
            box.appendChild(row("Compression", count(cmp.savedChars) + " chars saved"));
            if (cmp.originalChars && cmp.compressedChars) {
                box.appendChild(
                    row("Chars", count(cmp.originalChars) + " -> " + count(cmp.compressedChars), {
                        sub: true,
                    }),
                );
            }
            if (cmp.truncatedMessages) {
                box.appendChild(row("Truncated", String(cmp.truncatedMessages), { sub: true }));
            }
            if (cmp.removedMessages) {
                box.appendChild(row("Removed", String(cmp.removedMessages), { sub: true }));
            }
            if (cmp.prunedToolCalls) {
                box.appendChild(row("Pruned tools", String(cmp.prunedToolCalls), { sub: true }));
            }
            if (cmp.foldedToolResults) {
                box.appendChild(
                    row("Folded results", String(cmp.foldedToolResults), { sub: true }),
                );
            }
        }
    }

    group("Last turn");
    box.appendChild(row(u.estimated ? "Input estimate" : "Input (prompt)", fmtTokens(used)));
    if (u.requestChars) {
        box.appendChild(row("Request chars", count(u.requestChars), { sub: true }));
    }
    if (u.requestMessageCount) {
        box.appendChild(row("Messages", String(u.requestMessageCount), { sub: true }));
    }
    if (u.requestToolCount) {
        box.appendChild(row("Tools", String(u.requestToolCount), { sub: true }));
    }
    if (cache) {
        box.appendChild(row("Cached", fmtTokens(cache), { sub: true, note: cachePct + "% hit" }));
        box.appendChild(row("Fresh", fmtTokens(fresh), { sub: true }));
    }
    box.appendChild(row("Output", fmtTokens(out)));
    if (reasoning) {
        box.appendChild(row("Reasoning", fmtTokens(reasoning), { sub: true }));
    }
    box.appendChild(row("Total tokens", fmtTokens(total)));
    if (lastTurn.costUsd) {
        box.appendChild(row("Cost", "$" + lastTurn.costUsd.toFixed(4)));
    }
    if (sessionCostUsd > 0) {
        box.appendChild(row("Session cost", "$" + sessionCostUsd.toFixed(4)));
    }

    if (lastTurn.durationMs || u.durationMs || u.ttfbMs || u.firstDeltaMs) {
        group("Runtime");
        if (lastTurn.durationMs) {
            box.appendChild(row("Turn time", ms(lastTurn.durationMs)));
        }
        if (u.durationMs) {
            box.appendChild(row("Model call", ms(u.durationMs)));
        }
        if (u.ttfbMs) {
            box.appendChild(row("TTFB", ms(u.ttfbMs)));
        }
        if (u.firstDeltaMs) {
            box.appendChild(row("First delta", ms(u.firstDeltaMs)));
        }
    }

    // Inspect (analysis): open the compact model context and the literal last
    // request as read-only editor tabs. The full transcript stays on screen.
    const insp = document.createElement("div");
    insp.className = "uInspect";
    const mkInspect = (
        label: string,
        target: "context" | "request",
        title: string,
    ): HTMLButtonElement => {
        const b = document.createElement("button");
        b.className = "uInspectBtn";
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", () => {
            hideCtx();
            postMessage({ type: "inspect", target: target });
        });
        return b;
    };
    insp.appendChild(
        mkInspect("Model context", "context", "Open exactly what the model receives now (compact)"),
    );
    insp.appendChild(
        mkInspect(
            "Last request",
            "request",
            "Open the literal last request body sent to the gateway",
        ),
    );
    box.appendChild(insp);

    // Only offer Compact when the active backend advertises it. Native API
    // backends can intercept /compact locally; others may omit the command.
    if (commands.some((c) => c.name === "compact")) {
        const btn = document.createElement("button");
        btn.className = "uCompact";
        btn.textContent = "Compact Conversation";
        btn.addEventListener("click", () => {
            hideCtx();
            input.value = "/compact";
            send();
        });
        box.appendChild(btn);
    }
    ctxMenu.appendChild(box);
    ctxMenu.style.display = "block";
    positionPopover(anchor);
}
