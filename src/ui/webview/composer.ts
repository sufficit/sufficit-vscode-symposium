// Composer: input, send/edit/slash/paste, attachment chips. Listeners run on import.
import { postMessage } from "./vscode";
import {
    log,
    input,
    sendMode,
    sendBtn,
    cancelEditBtn,
    addContext,
    addBrowserPage,
    slash,
    composerEl,
} from "./dom";
import {
    attachments,
    activeFile,
    activeFileRange,
    activeFileDismissed,
    activeFilePreview,
    activeFilePinned,
    busy,
    conversationRows,
    commands,
    composerBlockedReason,
    setAttachments,
    setBusy,
    autonomyValue,
    permissionValue,
} from "./state";
import { setStatus } from "./status";
import { modelValue, reasoningValue } from "./models";
import { resizeInput } from "./inputSizing";
import { addOptimisticUserMessage } from "./messageBridge";
import { registerComposerBridge } from "./composerBridge";
import type { WebviewToHost } from "../../protocol/chat";
import type { SlashCommand } from "./types";
// Voice input (Web Speech + host/local capture) is extracted to ./voice; its
// listeners run on import, so importing it here preserves registration order.
import {
    isVoiceRecording,
    isVoiceTranscribing,
    endDictationMode,
    stopVoiceRecording,
} from "./voice";

import { saveCurrentComposerDraft, renderChips } from "./composerAttachments";
export { renderChips, restoreComposerDraft, saveCurrentComposerDraft } from "./composerAttachments";
export function clearComposer(): void {
    editAnchor = null;
    input.value = "";
    setAttachments([]);
    resizeInput();
    markEditing();
    renderChips();
    setStatus();
}
let editAnchor: number | null = null;
let sendSeq = 0;
export function markEditing() {
    log.querySelectorAll("[data-msg-index]").forEach((el) => {
        const item = el as HTMLElement;
        const i = Number(item.dataset.msgIndex || "-1");
        item.classList.toggle("willReplace", editAnchor != null && i >= editAnchor);
    });
    composerEl.classList.toggle("editing", editAnchor != null);
    cancelEditBtn.style.display = editAnchor != null ? "inline-flex" : "none";
}
export function lastUserRow() {
    for (let i = conversationRows.length - 1; i >= 0; i--) {
        if (conversationRows[i].role === "user") {
            return { idx: i, text: conversationRows[i].text || "" };
        }
    }
    return null;
}
export function beginEdit(idx: number, text: string): void {
    editAnchor = idx;
    input.value = text;
    resizeInput();
    markEditing();
    saveCurrentComposerDraft();
    input.focus();
}
export function cancelEdit() {
    if (editAnchor == null) {
        return;
    }
    editAnchor = null;
    input.value = "";
    resizeInput();
    markEditing();
    saveCurrentComposerDraft();
}
cancelEditBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    cancelEdit();
    input.focus();
});
// A voice recording is still active (e.g. local/whisper capture, which only
// transcribes on stop — see voice.ts). Sending now would fire with whatever
// happens to be in the input at this instant (usually empty/just the dots
// animation), and the eventual transcript would land in the box AFTER the
// message was already sent, looking like the send silently ate the text.
// Instead: stop the recording for the user (Send doubles as "I'm done
// talking") and defer the actual send until its transcript is in.
let pendingVoiceSend = false;
let pendingVoiceSendMode: string | undefined;
window.addEventListener("symposium-voice-ended", () => {
    if (!pendingVoiceSend) {
        return;
    }
    pendingVoiceSend = false;
    const mode = pendingVoiceSendMode;
    pendingVoiceSendMode = undefined;
    send(mode);
});

// Tracks whether the current input text originated from speech-to-text.
// Set when a voice transcript lands; cleared on manual edit/send.
let lastInputWasSpeech = false;
export function setSpeechInput(v: boolean): void {
    lastInputWasSpeech = v;
}

export function send(modeOverride = "") {
    if (composerBlockedReason) {
        return;
    }
    if (isVoiceRecording()) {
        pendingVoiceSend = true;
        pendingVoiceSendMode = modeOverride;
        stopVoiceRecording();
        return;
    }
    if (isVoiceTranscribing()) {
        // A segment just auto-stopped (e.g. VAD silence) and its transcript
        // hasn't landed yet — isVoiceRecording() is already false here, so
        // sending now would use stale/incomplete text; the pending result
        // would then land AFTER send and, in continuous mode, restart the
        // mic right into the box send() just cleared. End dictation mode so
        // that restart can't happen, and defer: the stt-result/stt-error
        // handler's dispatchVoiceEnded() fires the actual send once the
        // final text is in.
        endDictationMode();
        pendingVoiceSend = true;
        pendingVoiceSendMode = modeOverride;
        return;
    }
    const text = input.value.trim();
    // While busy with an empty composer, the button acts as Stop (nothing to send).
    if (!text) {
        if (busy) {
            postMessage({ type: "cancel" });
        }
        return;
    }
    // While a turn runs, only queue/steer may submit; plain send waits too
    // (the extension queues it), so allow submitting in every mode.
    input.value = "";
    resizeInput();
    const atts = attachments.map((a) => a.path);
    // A preview-tab file is only attached when the user pinned it (clicked the
    // suggestion); a really-open file auto-attaches as before. Skip the
    // auto-attach when that same path is ALREADY in the manual attachments
    // list (e.g. picked via the file picker while it's also the active
    // editor tab) — otherwise it's sent (and shown) as two chips for one file.
    if (
        activeFile &&
        !activeFileDismissed &&
        (!activeFilePreview || activeFilePinned) &&
        !attachments.some((a) => a.path === activeFile)
    ) {
        atts.unshift(
            activeFile +
                (activeFileRange
                    ? " (selected lines " + activeFileRange.start + "-" + activeFileRange.end + ")"
                    : ""),
        );
    }
    const editFrom = editAnchor;
    const clientMessageId =
        editFrom == null
            ? "local-" + Date.now().toString(36) + "-" + (++sendSeq).toString(36)
            : undefined;
    const effectiveMode = modeOverride || sendMode.value;
    const payload: WebviewToHost = {
        type: "send",
        text,
        attachments: atts,
        model: modelValue,
        reasoning: reasoningValue,
        permission: permissionValue,
        mode: effectiveMode,
        autonomy: autonomyValue,
        editFrom: editFrom ?? undefined,
        clientMessageId,
        speech: lastInputWasSpeech,
    };
    // Reset the speech flag after send so a manual follow-up isn't marked.
    lastInputWasSpeech = false;
    postMessage(payload);
    // A plain send while busy is QUEUED host-side (see ChatController.onSend) —
    // it won't actually dispatch until the current turn ends. Showing the
    // bubble now would splice it into the middle of the still-streaming turn;
    // the Queued panel already reflects it. The real "user" event (fired at
    // actual dispatch time) creates the bubble then, in the right order.
    // Steer interrupts immediately, so it stays optimistic.
    if (clientMessageId && (!busy || effectiveMode === "steer")) {
        addOptimisticUserMessage(clientMessageId, text);
    }
    if (editAnchor != null) {
        editAnchor = null;
        markEditing();
    }
    if (!busy && editFrom == null) {
        setBusy(true);
    }
    setAttachments([]);
    renderChips();
    saveCurrentComposerDraft();
    setStatus();
}
let slashMatches: SlashCommand[] = [];
let slashSel = 0;
export function slashActive() {
    return slash.style.display === "block";
}
export function updateSlash() {
    const v = input.value;
    // Only when the line is a single "/token" (slash first, no whitespace yet).
    const oneToken = v.charAt(0) === "/" && v.indexOf(" ") === -1 && v.indexOf("\n") === -1;
    if (!oneToken || !commands.length) {
        slash.style.display = "none";
        return;
    }
    const q = v.slice(1).toLowerCase();
    slashMatches = commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 50);
    if (!slashMatches.length) {
        slash.style.display = "none";
        return;
    }
    slashSel = Math.min(slashSel, slashMatches.length - 1);
    renderSlash();
    slash.style.display = "block";
}
export function renderSlash() {
    slash.textContent = "";
    slashMatches.forEach((c, i) => {
        const el = document.createElement("div");
        el.className = "slashItem" + (i === slashSel ? " sel" : "");
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = "/" + c.name;
        const ds = document.createElement("span");
        ds.className = "ds";
        ds.textContent = c.description || c.kind || "";
        el.appendChild(nm);
        el.appendChild(ds);
        el.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            acceptSlash(i);
        });
        slash.appendChild(el);
    });
}
export function acceptSlash(i: number): void {
    const c = slashMatches[i];
    if (!c) return;
    input.value = "/" + c.name + " ";
    slash.style.display = "none";
    slashSel = 0;
    input.focus();
}
sendBtn.addEventListener("click", () => {
    send();
});
addContext.addEventListener("click", () => postMessage({ type: "pick-attachments" }));
export function setBrowserOpen(open: boolean): void {
    if (addBrowserPage) {
        addBrowserPage.style.display = open ? "" : "none";
    }
}
input.addEventListener("keydown", (e) => {
    if (slashActive()) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            slashSel = (slashSel + 1) % slashMatches.length;
            renderSlash();
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            slashSel = (slashSel - 1 + slashMatches.length) % slashMatches.length;
            renderSlash();
            return;
        }
        if (e.key === "Tab" || e.key === "Enter") {
            e.preventDefault();
            acceptSlash(slashSel);
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            slash.style.display = "none";
            return;
        }
    }
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // Per-mode shortcuts: Ctrl/Cmd+Enter steers, Alt+Enter queues,
        // plain Enter uses the selected default mode.
        if (e.ctrlKey || e.metaKey) send("steer");
        else if (e.altKey) send("queue");
        else send();
    }
    if (e.key === "Escape") {
        if (editAnchor != null) {
            e.preventDefault();
            cancelEdit();
        } else if (busy) {
            postMessage({ type: "cancel" });
        }
    }
});
input.addEventListener("input", () => {
    resizeInput();
    updateSlash();
    saveCurrentComposerDraft();
    setStatus();
});
setStatus();

input.addEventListener("blur", () => {
    setTimeout(() => {
        slash.style.display = "none";
    }, 120);
});

export function handlePaste(e: ClipboardEvent): void {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (!file) continue;
            e.preventDefault();
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = String(reader.result).split(",")[1] || "";
                postMessage({ type: "paste-image", mime: item.type, data: base64 });
            };
            reader.readAsDataURL(file);
            return;
        }
    }
}
document.addEventListener("paste", handlePaste);

registerComposerBridge({ beginEdit, lastUserRow, renderChips, setSpeechInput });
