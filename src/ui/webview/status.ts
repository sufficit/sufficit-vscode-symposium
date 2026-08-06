// Status text, composer "working" indicator, loading state, the send-button
// title, and the send-mode constants (shared with the composer's send-mode menu).
import { sendMode, sendGroup, sendIcon, sendBtn, sendCaret, stopBtn, status, modelPicker, reasoningPicker, progress, composerEl, composerBlockedNotice, root, input, addContext, addBrowserPage, micBtn, presencePicker } from "./dom";
import { attachments, activeFile, activeFileDismissed, activeFilePinned, activeFilePreview, busy, queued, activeModel, loading, composerBlockedReason, setComposerBlockedReason, setLoadingFlag } from "./state";
import { modelLabel, modelList, reasoningList } from "./models";
import { normalizeBusySendMode } from "../sendMode";

export const isMac = navigator.platform.indexOf("Mac") === 0;
export const MOD = isMac ? "⌘" : "Ctrl";
export const ALT = isMac ? "⌥" : "Alt";
export const MODE_LABELS: any = { send: "Send", queue: "Queue", steer: "Steer", redirect: "Redirect" };
export const MODE_KBD: any = { send: "Enter", queue: ALT + "+Enter", steer: MOD + "+Enter", redirect: "Dropdown" };
export const MODE_ICONS: any = {
    // paper plane
    send: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.2 2.8 3 8 1.2 13.2a.5.5 0 0 0 .7.6l13-5.5a.5.5 0 0 0 0-.9l-13-5.5a.5.5 0 0 0-.7.6Z"/></svg>',
    // clock (wait, then send)
    queue: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 0 11Z"/><path d="M7.25 4h1.5v4.1l2.9 1.7-.75 1.3-3.65-2.15V4Z"/></svg>',
    // lightning bolt (interrupt and send now)
    steer: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.4 1 3 9h3.6l-1.3 6 7.7-9.2H9.2L10.5 1H9.4Z"/></svg>',
    // curved arrow (redirect: cancel current, correct next)
    redirect: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a6 6 0 0 0-6 6h2a4 4 0 1 1 4 4v-2.5L4.5 13 8 15.5V13A6 6 0 0 0 8 2Z"/></svg>',
};
export const MODE_DESC: any = {
    send: "Send now; queued while a turn runs",
    queue: "Always wait for the current turn (FIFO)",
    steer: "Interrupt the running turn, CLEAR the queue, and send immediately",
    redirect: "Cancel the running turn and send the correction next (keeps the queue)",
};
export const STOP_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';

export function setComposerBlocked(reason: string, placeholder: string, defaultPlaceholder: string): void {
    const blocked = !!reason;
    setComposerBlockedReason(reason);
    composerEl.classList.toggle("blocked", blocked);
    input.disabled = blocked;
    input.placeholder = blocked ? placeholder : defaultPlaceholder;
    input.setAttribute("aria-label", blocked ? reason : defaultPlaceholder);
    if (blocked) { input.setAttribute("aria-describedby", "composerBlockedNotice"); }
    else { input.removeAttribute("aria-describedby"); }
    const noticeText = composerBlockedNotice.querySelector("span");
    if (noticeText) { noticeText.textContent = reason; }
    for (const control of [addContext, addBrowserPage, micBtn, modelPicker, reasoningPicker, presencePicker]) {
        control.disabled = blocked;
    }
    const execPicker = document.getElementById("execPicker") as HTMLButtonElement | null;
    if (execPicker) { execPicker.disabled = blocked; }
    setStatus();
}

export function hasSendableInput() {
    const hasText = !!input.value.trim();
    const hasAttachments = attachments.length > 0;
    const hasPinnedActiveFile = !!activeFile && !activeFileDismissed && (!activeFilePreview || activeFilePinned);
    return hasText || hasAttachments || hasPinnedActiveFile;
}

export function updateSendTitle() {
    if (composerBlockedReason) {
        sendGroup.classList.remove("busy", "redirect", "steer", "stopping");
        sendIcon.innerHTML = MODE_ICONS.send;
        sendBtn.disabled = true;
        sendBtn.title = composerBlockedReason;
        sendCaret.style.display = "none";
        stopBtn.style.display = "none";
        return;
    }
    // Idle: plain Send (paper plane). While a turn runs, the button reflects what
    // the NEXT message will do — queue, redirect, or steer — per the selected
    // mode. Interruption is never presented with the queue clock.
    const canSend = hasSendableInput();
    if (busy) {
        const mode = normalizeBusySendMode((sendMode as HTMLSelectElement).value);
        sendGroup.classList.add("busy");
        sendGroup.classList.toggle("steer", mode === "steer");
        sendGroup.classList.toggle("redirect", mode === "redirect");
        sendIcon.innerHTML = MODE_ICONS[mode];
        (sendBtn as HTMLButtonElement).disabled = !canSend;
        (sendBtn as HTMLButtonElement).title = canSend
            ? (mode === "steer"
                ? "Steer: interrupt the running turn, clear the queue, and send now (Ctrl/Cmd+Enter) · Esc to stop"
                : mode === "redirect"
                  ? "Redirect: cancel the running turn and send the correction next · Esc to stop"
                  : "Queue: send after the current turn finishes (Alt+Enter) · Esc to stop")
            : "Type a message to send · Esc to stop";
        sendCaret.style.display = "";
        stopBtn.style.display = "";
        return;
    }
    sendGroup.classList.remove("busy", "redirect", "steer", "stopping");
    sendIcon.innerHTML = MODE_ICONS.send;
    (sendBtn as HTMLButtonElement).disabled = !canSend;
    (sendBtn as HTMLButtonElement).title = canSend ? "Send (Enter)" : "Type a message to send";
    sendCaret.style.display = "none";
    stopBtn.style.display = "none";
}

export function setStatus(override?: string) {
    const q = queued > 0 ? " · " + queued + " queued" : "";
    status.textContent = composerBlockedReason ? "" : (override ?? (busy ? ("thinking..." + q) : (activeModel ? "model: " + modelLabel(activeModel) : "")));
    // The model menu remains useful with an empty catalog: it exposes Refresh
    // models and manual entry, which is how a new Sufficit installation recovers
    // after presets/login become available. Reasoning has no such fallback.
    (modelPicker as HTMLButtonElement).disabled = !!composerBlockedReason;
    (reasoningPicker as HTMLButtonElement).disabled = !!composerBlockedReason || !reasoningList.length;
    updateSendTitle();   // mode caret/icon depends on busy state
    syncProgress();
}

// Busy/loading shows as a subtle sweep around the composer border (native-chat
// style), not a top bar that reads as global.
export function syncProgress() {
    const on = loading || busy;
    progress.classList.remove("on");          // retire the top bar
    if (composerEl) { composerEl.classList.toggle("working", on); }
}
// Full loading state shown while a session is being opened (empty log).
export function setLoading(on: boolean, text?: string) {
    setLoadingFlag(on);
    if (text) { (document.getElementById("loadingText") as HTMLElement).textContent = text; }
    root.classList.toggle("loading", on);
    syncProgress();
}
