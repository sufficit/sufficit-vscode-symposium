import { renderChips, saveCurrentComposerDraft } from "./composer";
import { input, log, sendBtn } from "./dom";
import {
    confirmOptimisticMessage,
    endStream,
    message,
    withdrawOptimisticMessage,
} from "./messages";
import {
    markMessageDispatched,
    resetDispatchedMessages,
    wasMessageDispatched,
} from "./dispatchedMessages";
import { renderQueued, resetWorkingState } from "./panels";
import { refreshEmpty, armStickyUserMessage } from "./scroll";
import { resetToolRows } from "./tools";
import { svgIcon } from "./icons";
import { postMessage } from "./vscode";
import { resizeInput } from "./inputSizing";
import { setComposerBlocked, setStatus } from "./status";
import { t } from "./i18n";
import { attachments, setBusy, setConversationRows, setQueueHeld, setQueued } from "./state";
import { setLastUsage, setLastTurn, setSessionCostUsd } from "./statusbar";
import type { QueueItem } from "./types";

/** Clears only conversation-owned presentation state. Session metadata and the
 * surrounding surface remain intact while an AHP snapshot replaces the chat. */
export function resetConversationView(): void {
    setConversationRows([]);
    resetDispatchedMessages();
    log.textContent = "";
    setBusy(false);
    setQueued(0);
    setQueueHeld(false);
    setLastUsage(null);
    setLastTurn({});
    setSessionCostUsd(0);
    resetWorkingState();
    resetToolRows();
    refreshEmpty();
    setComposerBlocked("", t("chat.composer.placeholder"), t("chat.composer.placeholder"));
    sendBtn.disabled = false;
    const composer = document.getElementById("composer");
    if (composer) composer.style.display = "flex";
    setStatus();
}

/** Renders a user turn from either a host event or the authoritative AHP state. */
export function renderUserTurn(
    text: string,
    attachmentPaths: readonly string[] = [],
    clientMessageId?: string,
    timestamp?: string | number,
): HTMLElement {
    endStream();
    markMessageDispatched(clientMessageId);
    const element = confirmOptimisticMessage(clientMessageId) || message("user", text, timestamp);
    armStickyUserMessage(element);
    if (attachmentPaths.length) {
        const list = document.createElement("div");
        list.className = "msgAtts";
        for (const path of attachmentPaths) {
            const attachment = document.createElement("span");
            attachment.className = "msgAtt";
            attachment.title = "Abrir " + path;
            const icon = svgIcon("file");
            icon.classList.add("chipIcon");
            attachment.appendChild(icon);
            const cleanPath = String(path).replace(/ [(]selected lines.*$/, "");
            const label = document.createElement("span");
            label.textContent = String(path).split("/").pop() ?? "";
            attachment.appendChild(label);
            attachment.addEventListener("click", () =>
                postMessage({ type: "open-file", path: cleanPath }),
            );
            list.appendChild(attachment);
        }
        element.appendChild(list);
    }
    setBusy(true);
    setStatus();
    resizeInput();
    return element;
}

/** Reconciles the queue panel from one authoritative ChatState-derived list. */
export function renderQueueView(
    items: QueueItem[],
    held: boolean,
    busy?: boolean,
    staleIds: readonly string[] = [],
): void {
    for (const item of items) withdrawOptimisticMessage(item.clientMessageId);
    for (const id of staleIds) withdrawOptimisticMessage(id);
    renderQueued(
        items.filter((item) => !wasMessageDispatched(item.clientMessageId)),
        held,
    );
    if (typeof busy === "boolean") setBusy(busy);
}

/** Loads an AHP pending message into the composer for editing. */
export function loadPendingInput(text: string, paths: readonly string[]): void {
    input.value = text;
    resizeInput();
    input.focus();
    for (const path of paths) {
        if (!attachments.some((attachment) => attachment.path === path)) {
            attachments.push({ path, name: String(path).split("/").pop() || path });
        }
    }
    renderChips();
    saveCurrentComposerDraft();
}
