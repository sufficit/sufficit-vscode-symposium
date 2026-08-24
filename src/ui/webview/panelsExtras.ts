// Guardrails + queued-messages panels — split out of panels.ts (check:size).
import { postMessage } from "./vscode";
import { guardrailsEl, queuedEl } from "./dom";
import { setQueueHeld, setQueued } from "./state";
import { setStatus } from "./status";
import { svgIcon } from "./icons";
import { refreshPanelLayout } from "./panelBridge";
import type { GuardrailItem, QueueItem } from "./types";

// ---- guardrails (agent-defined absolute rules, sent every message) ----
// Live-binding export (mirrors state.ts): panels.ts reads the count for its tab badge.
export let lastGuardrailItems: GuardrailItem[] = [];
export function renderGuardrails(items: GuardrailItem[]): void {
    lastGuardrailItems = items || [];
    guardrailsEl.textContent = "";
    if (!lastGuardrailItems.length) {
        guardrailsEl.classList.remove("has");
        refreshPanelLayout();
        return;
    }
    const card = document.createElement("div");
    card.className = "grcard";
    const head = document.createElement("div");
    head.className = "grhead";
    head.appendChild(svgIcon("shield"));
    const ttl = document.createElement("span");
    ttl.className = "grtitle";
    ttl.textContent = "Guardrails";
    ttl.title =
        "Absolute rules the agent set for this session, sent on every message. The agent adds them; you can remove or clear them.";
    const cnt = document.createElement("span");
    cnt.className = "grcount";
    cnt.textContent = String(lastGuardrailItems.length);
    const clear = document.createElement("button");
    clear.className = "grbtn";
    clear.title = "Clear all guardrails";
    clear.setAttribute("aria-label", "Clear all guardrails");
    clear.appendChild(svgIcon("trash"));
    clear.addEventListener("click", (e) => {
        e.stopPropagation();
        if (lastGuardrailItems.length) {
            postMessage({ type: "clear-guardrails" });
        }
    });
    head.appendChild(ttl);
    head.appendChild(cnt);
    head.appendChild(clear);
    card.appendChild(head);
    const list = document.createElement("div");
    list.className = "grlist";
    for (const it of lastGuardrailItems) {
        const row = document.createElement("div");
        row.className = "gritem";
        const txt = document.createElement("span");
        txt.className = "grtext";
        txt.textContent = it.text;
        txt.title = it.text;
        const del = document.createElement("button");
        del.className = "grdel";
        del.title = "Remove";
        del.textContent = "✕";
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            postMessage({ type: "remove-guardrail", id: it.id });
        });
        row.appendChild(txt);
        row.appendChild(del);
        list.appendChild(row);
    }
    card.appendChild(list);
    guardrailsEl.appendChild(card);
    guardrailsEl.classList.add("has");
    refreshPanelLayout();
}

// ---- queued messages (editable until dispatched) ----
export function renderQueued(items: QueueItem[], held = false): void {
    setQueued(items.length); // keep status text in sync
    setQueueHeld(held && items.length > 0);
    queuedEl.textContent = "";
    if (!items.length) {
        queuedEl.classList.remove("has");
        setStatus();
        return;
    }
    queuedEl.classList.add("has");
    queuedEl.classList.toggle("qheld", held);
    const head = document.createElement("div");
    head.className = "qhead";
    head.textContent = held ? "Queue paused" : "Queued";
    queuedEl.appendChild(head);
    if (held) {
        const banner = document.createElement("div");
        banner.className = "qheldBanner";
        banner.setAttribute("role", "status");
        banner.setAttribute("aria-live", "polite");
        const text = document.createElement("span");
        text.textContent =
            items.length === 1
                ? "The previous turn failed. New messages send now; this one stays paused until you choose Send next."
                : "The previous turn failed. New messages send now; these stay paused until you choose Send next.";
        banner.appendChild(text);
        const discard = document.createElement("button");
        discard.className = "qheldDiscard";
        discard.textContent = "Discard all";
        discard.title = "Remove every held message from the queue";
        discard.addEventListener("click", () => postMessage({ type: "queue-clear" }));
        banner.appendChild(discard);
        queuedEl.appendChild(banner);
    }
    for (const it of items) {
        const row = document.createElement("div");
        row.className = "qitem";
        const main = document.createElement("div");
        main.className = "qmain";
        const txt = document.createElement("div");
        txt.className = "qtext";
        txt.textContent = it.text;
        txt.title = "Click to edit";
        txt.addEventListener("click", () => postMessage({ type: "queue-edit", id: it.id }));
        main.appendChild(txt);
        if (it.attachments && it.attachments.length) {
            const atts = document.createElement("div");
            atts.className = "qatts";
            for (const p of it.attachments) {
                const chip = document.createElement("span");
                chip.className = "qatt";
                chip.title = p;
                const ic = svgIcon("file");
                ic.classList.add("qattIcon");
                chip.appendChild(ic);
                chip.appendChild(document.createTextNode(String(p).split("/").pop() || p));
                atts.appendChild(chip);
            }
            main.appendChild(atts);
        }
        const acts = document.createElement("span");
        acts.className = "qacts";
        const mkBtn = (
            icon: string,
            title: string,
            type: "queue-edit" | "queue-promote" | "queue-remove",
        ): HTMLButtonElement => {
            const b = document.createElement("button");
            b.className = "qbtn";
            b.title = title;
            b.appendChild(svgIcon(icon));
            b.addEventListener("click", (e) => {
                e.stopPropagation();
                postMessage({ type, id: it.id });
            });
            return b;
        };
        acts.appendChild(mkBtn("edit", "Edit", "queue-edit"));
        acts.appendChild(mkBtn("up", "Send next", "queue-promote"));
        acts.appendChild(mkBtn("x", "Remove", "queue-remove"));
        row.appendChild(main);
        row.appendChild(acts);
        queuedEl.appendChild(row);
    }
    setStatus();
}
