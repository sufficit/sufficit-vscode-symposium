// Status text, composer "working" indicator, loading state, the send-button
// title, and the send-mode constants (shared with the composer's send-mode menu).
import { sendMode, sendGroup, sendIcon, sendBtn, sendCaret, stopBtn, status, modelPicker, reasoningPicker, progress, composerEl, root, input } from "./dom";
import { attachments, activeFile, activeFileDismissed, activeFilePinned, activeFilePreview, busy, queued, activeModel, loading, setLoadingFlag } from "./state";
import { modelLabel, modelList, reasoningList } from "./models";

export const isMac = navigator.platform.indexOf("Mac") === 0;
export const MOD = isMac ? "⌘" : "Ctrl";
export const ALT = isMac ? "⌥" : "Alt";
export const MODE_LABELS: any = { send: "Send", queue: "Queue", steer: "Steer" };
export const MODE_KBD: any = { send: "Enter", queue: ALT + "+Enter", steer: MOD + "+Enter" };
export const MODE_ICONS: any = {
    // paper plane
    send: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.2 2.8 3 8 1.2 13.2a.5.5 0 0 0 .7.6l13-5.5a.5.5 0 0 0 0-.9l-13-5.5a.5.5 0 0 0-.7.6Z"/></svg>',
    // clock (wait, then send)
    queue: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 0 11Z"/><path d="M7.25 4h1.5v4.1l2.9 1.7-.75 1.3-3.65-2.15V4Z"/></svg>',
    // lightning bolt (interrupt and send now)
    steer: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.4 1 3 9h3.6l-1.3 6 7.7-9.2H9.2L10.5 1H9.4Z"/></svg>',
};
export const MODE_DESC: any = {
    send: "Send now; queued while a turn runs",
    queue: "Always wait for the current turn (FIFO)",
    steer: "Interrupt the running turn and send now",
};
export const STOP_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';

export function hasSendableInput() {
    const hasText = !!input.value.trim();
    const hasAttachments = attachments.length > 0;
    const hasPinnedActiveFile = !!activeFile && !activeFileDismissed && (!activeFilePreview || activeFilePinned);
    return hasText || hasAttachments || hasPinnedActiveFile;
}

export function updateSendTitle() {
    // Idle: plain Send (paper plane). While a turn runs, the button reflects what
    // the NEXT message will do — queue (clock) or steer (lightning) — per the
    // selected mode. Clicking sends in that mode; Stop the running turn with Esc.
    const canSend = hasSendableInput();
    if (busy) {
        const mode = ((sendMode as HTMLSelectElement).value === "steer") ? "steer" : "queue";
        sendGroup.classList.add("busy");
        sendGroup.classList.toggle("steer", mode === "steer");
        sendIcon.innerHTML = MODE_ICONS[mode];
        (sendBtn as HTMLButtonElement).disabled = !canSend;
        (sendBtn as HTMLButtonElement).title = canSend
            ? ((mode === "steer")
                ? "Steer: interrupt the running turn and send now (Ctrl/Cmd+Enter) · Esc to stop"
                : "Queue: send after the current turn finishes (Alt+Enter) · Esc to stop")
            : "Type a message to send · Esc to stop";
        sendCaret.style.display = "";
        stopBtn.style.display = "";
        return;
    }
    sendGroup.classList.remove("busy", "steer", "stopping");
    sendIcon.innerHTML = MODE_ICONS.send;
    (sendBtn as HTMLButtonElement).disabled = !canSend;
    (sendBtn as HTMLButtonElement).title = canSend ? "Send (Enter)" : "Type a message to send";
    sendCaret.style.display = "none";
    stopBtn.style.display = "none";
}

export function setStatus() {
    const q = queued > 0 ? " · " + queued + " queued" : "";
    status.textContent = busy ? ("thinking..." + q) : (activeModel ? "model: " + modelLabel(activeModel) : "");
    // Model/reasoning stay changeable at all times (a change applies to the next
    // message); only disabled when there are no options to pick.
    (modelPicker as HTMLButtonElement).disabled = !modelList.length;
    (reasoningPicker as HTMLButtonElement).disabled = !reasoningList.length;
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
