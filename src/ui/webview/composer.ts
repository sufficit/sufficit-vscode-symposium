// Composer: input, send/edit/slash/paste, attachment chips. Listeners run on import.
import { vscode, saved, saveState } from "./vscode";
import { log, input, sendMode, sendBtn, sendGroup, sendCaret, stopBtn, chips, addContext, addBrowserPage, slash, composerEl, ctxMenu } from "./dom";
import { attachments, activeFile, activeFileRange, activeFileDismissed, activeFilePreview, activeFilePinned, busy, currentBackend, conversationRows, commands, composerBlockedReason, setAttachments, setActiveFile, setActiveFileRange, setActiveFileDismissed, setActiveFilePreview, setActiveFilePinned, setBusy, setConversationRows, setCommands, autonomyValue, permissionValue } from "./state";
import { setStatus, updateSendTitle, MODE_LABELS, MODE_KBD, MODE_ICONS, MODE_DESC, isMac, MOD, ALT } from "./status";
import { modelValue, reasoningValue } from "./models";
import { showToast, hideCtx } from "./menus";
import { scrollToBottom, autoScroll, nearBottom } from "./scroll";
import { svgIcon } from "./icons";
import { refreshPanels } from "./panels";
import { resizeInput } from "./inputSizing";
import { optimisticUserMessage } from "./messages";
// Voice input (Web Speech + host/local capture) is extracted to ./voice; its
// listeners run on import, so importing it here preserves registration order.
import { isVoiceRecording, isVoiceTranscribing, endDictationMode, stopVoiceRecording } from "./voice";

export function activeFileSuffix() { return activeFileRange ? ":" + activeFileRange.start + "-" + activeFileRange.end : ""; }
sendMode.addEventListener("change", () => saveState({ sendMode: sendMode.value }));
stopBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!busy) { return; }
    sendGroup.classList.add("stopping");
    vscode.postMessage({ type: "cancel" });
});
sendCaret.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ctxMenu.textContent = "";
    for (const mode of ["redirect", "queue", "steer"]) {
        const mi = document.createElement("div"); mi.className = "mi";
        mi.title = MODE_DESC[mode];
        const tick = document.createElement("span"); tick.className = "tick";
        tick.textContent = sendMode.value === mode ? "✓" : "";
        const ic = document.createElement("span"); ic.className = "miIcon"; ic.innerHTML = MODE_ICONS[mode];
        const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = MODE_LABELS[mode];
        const kbd = document.createElement("span"); kbd.className = "mikbd"; kbd.textContent = MODE_KBD[mode];
        mi.append(tick, ic, lbl, kbd);
        mi.addEventListener("click", () => { sendMode.value = mode; saveState({ sendMode: mode }); updateSendTitle(); });
        ctxMenu.appendChild(mi);
    }
    ctxMenu.style.display = "block";
    const r = sendCaret.getBoundingClientRect(); const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, r.right - w) + "px";
    ctxMenu.style.top = Math.max(4, r.top - h - 4) + "px";
});
export function makeChip(label, fullPath, onRemove, active, openPath) {
    const chip = document.createElement("span");
    chip.className = "chip" + (active ? " activeChip" : "");
    chip.title = openPath ? "Abrir " + (openPath) : fullPath;
    const ic = svgIcon("file"); ic.classList.add("chipIcon"); chip.appendChild(ic);
    const lb = document.createElement("span"); lb.className = "lbl"; lb.textContent = label; chip.appendChild(lb);
    const x = document.createElement("span"); x.className = "x"; x.textContent = "✕";
    x.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    chip.appendChild(x);
    // Click the chip body (not ✕) to open/preview the file.
    if (openPath) {
        chip.classList.add("clickable");
        chip.addEventListener("click", (e) => {
            if (e.target && e.target.classList && e.target.classList.contains("x")) { return; }
            vscode.postMessage({ type: "open-file", path: openPath });
        });
    }
    return chip;
}
export function renderChips() {
    chips.querySelectorAll(".chip").forEach((el) => el.remove());
    // Active editor file as a removable context chip (like the native chat).
    // A preview tab (italic, not really opened) is shown as a SUGGESTION only:
    // dimmed/dashed, not auto-attached — click it to attach.
    if (activeFile && !activeFileDismissed) {
        const base = (activeFile.split("/").filter(Boolean).pop() || activeFile) + activeFileSuffix();
        const isSuggestion = activeFilePreview && !activeFilePinned;
        // Suggestion chip clicks to PIN; an attached chip clicks to OPEN.
        const chip = makeChip(base, activeFile + activeFileSuffix(), () => { setActiveFileDismissed(true); renderChips(); }, !isSuggestion, isSuggestion ? null : activeFile);
        if (isSuggestion) {
            chip.classList.add("suggestChip");
            chip.title = activeFile + activeFileSuffix() + " — preview (clique para anexar ao contexto)";
            chip.addEventListener("click", (e) => {
                if (e.target && e.target.classList && e.target.classList.contains("x")) { return; }
                setActiveFilePinned(true); renderChips();
            });
        }
        chips.appendChild(chip);
    }
    // Skip a manual attachment that's ALSO the active-file chip above (same
    // path shown twice for one file — see send()'s matching guard).
    for (const file of attachments) {
        if (file.path === activeFile && !activeFileDismissed) { continue; }
        chips.appendChild(makeChip(file.name, file.path, () => {
            setAttachments(attachments.filter((a) => a.path !== file.path));
            renderChips();
        }, false, file.path));
    }
    // Attached files are a panel tab now — refresh the strip so its count/icon
    // tracks what's attached.
    refreshPanels();
}
let editAnchor = null;
let sendSeq = 0;
export function markEditing() {
    log.querySelectorAll("[data-msg-index]").forEach((el) => {
        const i = Number(el.dataset.msgIndex || "-1");
        el.classList.toggle("willReplace", editAnchor != null && i >= editAnchor);
    });
    document.getElementById("composer").classList.toggle("editing", editAnchor != null);
}
export function lastUserRow() {
    for (let i = conversationRows.length - 1; i >= 0; i--) {
        if (conversationRows[i].role === "user") { return { idx: i, text: conversationRows[i].text || "" }; }
    }
    return null;
}
export function beginEdit(idx, text) {
    editAnchor = idx;
    input.value = text;
    resizeInput();
    markEditing();
    input.focus();
}
export function cancelEdit() {
    if (editAnchor == null) { return; }
    editAnchor = null; input.value = "";
    resizeInput();
    markEditing();
}
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
    if (!pendingVoiceSend) { return; }
    pendingVoiceSend = false;
    const mode = pendingVoiceSendMode;
    pendingVoiceSendMode = undefined;
    send(mode);
});

// Tracks whether the current input text originated from speech-to-text.
// Set when a voice transcript lands; cleared on manual edit/send.
let lastInputWasSpeech = false;
export function setSpeechInput(v: boolean): void { lastInputWasSpeech = v; }

export function send(modeOverride) {
    if (composerBlockedReason) { return; }
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
    if (!text) { if (busy) { vscode.postMessage({ type: "cancel" }); } return; }
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
    if (activeFile && !activeFileDismissed && (!activeFilePreview || activeFilePinned) && !attachments.some((a) => a.path === activeFile)) {
        atts.unshift(activeFile + (activeFileRange ? " (selected lines " + activeFileRange.start + "-" + activeFileRange.end + ")" : ""));
    }
    const editFrom = editAnchor;
    const clientMessageId = editFrom == null ? "local-" + Date.now().toString(36) + "-" + (++sendSeq).toString(36) : undefined;
    const effectiveMode = modeOverride || sendMode.value;
    const payload = {
        type: "send",
        text,
        attachments: atts,
        model: modelValue,
        reasoning: reasoningValue,
        permission: permissionValue,
        mode: effectiveMode,
        autonomy: autonomyValue,
        editFrom: editFrom,
        clientMessageId,
        speech: lastInputWasSpeech,
    };
    // Reset the speech flag after send so a manual follow-up isn't marked.
    lastInputWasSpeech = false;
    vscode.postMessage(payload);
    // A plain send while busy is QUEUED host-side (see ChatController.onSend) —
    // it won't actually dispatch until the current turn ends. Showing the
    // bubble now would splice it into the middle of the still-streaming turn;
    // the Queued panel already reflects it. The real "user" event (fired at
    // actual dispatch time) creates the bubble then, in the right order.
    // Steer interrupts immediately, so it stays optimistic.
    if (clientMessageId && (!busy || effectiveMode === "steer")) { optimisticUserMessage(clientMessageId, text); }
    if (editAnchor != null) { editAnchor = null; markEditing(); }
    if (!busy && editFrom == null) { setBusy(true); }
    setAttachments([]);
    renderChips();
    setStatus();
}
let slashMatches = [];
let slashSel = 0;
export function slashActive() { return slash.style.display === "block"; }
export function updateSlash() {
    const v = input.value;
    // Only when the line is a single "/token" (slash first, no whitespace yet).
    const oneToken = v.charAt(0) === "/" && v.indexOf(" ") === -1 && v.indexOf("\n") === -1;
    if (!oneToken || !commands.length) { slash.style.display = "none"; return; }
    const q = v.slice(1).toLowerCase();
    slashMatches = commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 50);
    if (!slashMatches.length) { slash.style.display = "none"; return; }
    slashSel = Math.min(slashSel, slashMatches.length - 1);
    renderSlash();
    slash.style.display = "block";
}
export function renderSlash() {
    slash.textContent = "";
    slashMatches.forEach((c, i) => {
        const el = document.createElement("div");
        el.className = "slashItem" + (i === slashSel ? " sel" : "");
        const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = "/" + c.name;
        const ds = document.createElement("span"); ds.className = "ds"; ds.textContent = c.description || c.kind || "";
        el.appendChild(nm); el.appendChild(ds);
        el.addEventListener("mousedown", (ev) => { ev.preventDefault(); acceptSlash(i); });
        slash.appendChild(el);
    });
}
export function acceptSlash(i) {
    const c = slashMatches[i];
    if (!c) return;
    input.value = "/" + c.name + " ";
    slash.style.display = "none";
    slashSel = 0;
    input.focus();
}
sendBtn.addEventListener("click", () => { send(); });
addContext.addEventListener("click", () => vscode.postMessage({ type: "pick-attachments" }));
export function setBrowserOpen(open) { if (addBrowserPage) { addBrowserPage.style.display = open ? "" : "none"; } }
input.addEventListener("keydown", (e) => {
    if (slashActive()) {
        if (e.key === "ArrowDown") { e.preventDefault(); slashSel = (slashSel + 1) % slashMatches.length; renderSlash(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); slashSel = (slashSel - 1 + slashMatches.length) % slashMatches.length; renderSlash(); return; }
        if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); acceptSlash(slashSel); return; }
        if (e.key === "Escape") { e.preventDefault(); slash.style.display = "none"; return; }
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
        if (editAnchor != null) { e.preventDefault(); cancelEdit(); }
        else if (busy) { vscode.postMessage({ type: "cancel" }); }
    }
});
input.addEventListener("input", () => {
    resizeInput();
    updateSlash();
    setStatus();
});
setStatus();

input.addEventListener("blur", () => { setTimeout(() => { slash.style.display = "none"; }, 120); });

export function handlePaste(e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (!file) continue;
            e.preventDefault();
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = String(reader.result).split(",")[1] || "";
                vscode.postMessage({ type: "paste-image", mime: item.type, data: base64 });
            };
            reader.readAsDataURL(file);
            return;
        }
    }
}
document.addEventListener("paste", handlePaste);
