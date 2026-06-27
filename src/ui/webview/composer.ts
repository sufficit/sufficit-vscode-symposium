// Composer: input, send/edit/slash/paste, attachment chips. Listeners run on import.
import { vscode, saved, saveState } from "./vscode";
import { log, input, sendMode, micBtn, micPauseBtn, sendBtn, sendGroup, sendCaret, stopBtn, chips, addContext, addBrowserPage, slash, composerEl, ctxMenu } from "./dom";
import { attachments, activeFile, activeFileRange, activeFileDismissed, activeFilePreview, activeFilePinned, busy, currentBackend, conversationRows, commands, setAttachments, setActiveFile, setActiveFileRange, setActiveFileDismissed, setActiveFilePreview, setActiveFilePinned, setBusy, setConversationRows, setCommands, autonomyValue, permissionValue } from "./state";
import { setStatus, updateSendTitle, MODE_LABELS, MODE_KBD, MODE_ICONS, MODE_DESC, isMac, MOD, ALT } from "./status";
import { modelValue, reasoningValue } from "./models";
import { showToast, hideCtx } from "./menus";
import { scrollToBottom, autoScroll, nearBottom } from "./scroll";
import { svgIcon } from "./icons";
import { refreshPanels } from "./panels";

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
    for (const mode of ["queue", "steer"]) {
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
    for (const file of attachments) {
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
    input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px";
    markEditing();
    input.focus();
}
export function cancelEdit() {
    if (editAnchor == null) { return; }
    editAnchor = null; input.value = "";
    input.style.height = "auto";
    markEditing();
}
let lastSendPayload = null;   // last user submission, for error Retry
export function retryLast() {
    if (!lastSendPayload) { return; }
    vscode.postMessage(lastSendPayload);
    if (!busy) { setBusy(true); setStatus(); }
}
export function send(modeOverride) {
    const text = input.value.trim();
    // While busy with an empty composer, the button acts as Stop (nothing to send).
    if (!text) { if (busy) { vscode.postMessage({ type: "cancel" }); } return; }
    // While a turn runs, only queue/steer may submit; plain send waits too
    // (the extension queues it), so allow submitting in every mode.
    input.value = "";
    const atts = attachments.map((a) => a.path);
    // A preview-tab file is only attached when the user pinned it (clicked the
    // suggestion); a really-open file auto-attaches as before.
    if (activeFile && !activeFileDismissed && (!activeFilePreview || activeFilePinned)) {
        atts.unshift(activeFile + (activeFileRange ? " (selected lines " + activeFileRange.start + "-" + activeFileRange.end + ")" : ""));
    }
    const editFrom = editAnchor;
    const payload = {
        type: "send",
        text,
        attachments: atts,
        model: modelValue,
        reasoning: reasoningValue,
        permission: permissionValue,
        mode: modeOverride || sendMode.value,
        autonomy: autonomyValue,
        editFrom: editFrom,
    };
    lastSendPayload = { ...payload, editFrom: null };   // remember for Retry
    vscode.postMessage(payload);
    if (editAnchor != null) { editAnchor = null; markEditing(); }
    if (!busy && editFrom == null) { setBusy(true); setStatus(); }
    setAttachments([]);
    renderChips();
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
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
    updateSlash();
});

// Voice = record + transcribe. The old Web Speech path was dead in Electron
// (no SpeechRecognition backend). Instead we capture the mic with MediaRecorder
// and ship the audio to the host, which calls the gateway's Whisper-compatible
// /audio/transcriptions (token stays host-side). getUserMedia works in the VS
// Code webview; a permission prompt appears on first use.
const MIC_ICON = micBtn.innerHTML;
const PAUSE_ICON = micPauseBtn.innerHTML;
const RESUME_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 5 3.5Z"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';

let recorder: MediaRecorder | null = null;
let micStream: MediaStream | null = null;
let audioChunks: Blob[] = [];
let voiceState: "idle" | "recording" | "paused" | "transcribing" = "idle";

micBtn.title = "Gravar voz (clique para transcrever)";

function teardownStream() {
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    recorder = null;
    audioChunks = [];
}

/** Restore the composer voice controls to the idle (not-recording) state. */
export function resetVoiceUI() {
    voiceState = "idle";
    micBtn.disabled = false;
    micBtn.classList.remove("recording");
    micBtn.innerHTML = MIC_ICON;
    micBtn.title = "Gravar voz (clique para transcrever)";
    micPauseBtn.style.display = "none";
    micPauseBtn.innerHTML = PAUSE_ICON;
    micPauseBtn.title = "Pausar gravação";
    teardownStream();
}

/** Drop transcribed text into the composer at the caret and resize. */
export function insertTranscription(text: string) {
    resetVoiceUI();
    const t = (text || "").trim();
    if (!t) { showToast("Nada transcrito (áudio vazio?)."); return; }
    const el = input as HTMLTextAreaElement;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const sep = before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
    el.value = before + sep + t + after;
    const caret = (before + sep + t).length;
    el.focus();
    el.setSelectionRange(caret, caret);
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
    updateSlash();
}

/** Surface a transcription failure and return to idle. */
export function voiceError(message: string) {
    resetVoiceUI();
    showToast("Falha na transcrição: " + message);
}

function stopAndTranscribe() {
    if (!recorder || (voiceState !== "recording" && voiceState !== "paused")) { return; }
    voiceState = "transcribing";
    micBtn.disabled = true;
    micBtn.classList.remove("recording");
    micBtn.title = "Transcrevendo…";
    micPauseBtn.style.display = "none";
    try { recorder.stop(); } catch { resetVoiceUI(); }
}

async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast("Microfone indisponível neste ambiente.");
        return;
    }
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        const name = (err as { name?: string })?.name;
        showToast(name === "NotAllowedError"
            ? "Permissão de microfone negada. Libere o mic para o VS Code e tente de novo."
            : "Não consegui acessar o microfone: " + ((err as Error)?.message ?? name ?? "erro"));
        teardownStream();
        return;
    }
    audioChunks = [];
    try {
        recorder = new MediaRecorder(micStream);
    } catch {
        recorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) { audioChunks.push(e.data); } };
    recorder.onstop = () => {
        const mime = recorder?.mimeType || "audio/webm";
        const blob = new Blob(audioChunks, { type: mime });
        teardownStream();
        if (blob.size === 0) { resetVoiceUI(); showToast("Gravação vazia."); return; }
        const reader = new FileReader();
        reader.onload = () => {
            const data = String(reader.result).split(",")[1] || "";
            vscode.postMessage({ type: "transcribe-audio", mime, data });
        };
        reader.readAsDataURL(blob);
    };
    recorder.start();
    voiceState = "recording";
    micBtn.classList.add("recording");
    micBtn.innerHTML = STOP_ICON;
    micBtn.title = "Parar e transcrever";
    micPauseBtn.style.display = "";
    micPauseBtn.innerHTML = PAUSE_ICON;
    micPauseBtn.title = "Pausar gravação";
}

micBtn.addEventListener("click", () => {
    if (voiceState === "idle") { void startRecording(); }
    else if (voiceState === "recording" || voiceState === "paused") { stopAndTranscribe(); }
});

micPauseBtn.addEventListener("click", () => {
    if (!recorder) { return; }
    if (voiceState === "recording") {
        try { recorder.pause(); } catch { return; }
        voiceState = "paused";
        micPauseBtn.innerHTML = RESUME_ICON;
        micPauseBtn.title = "Retomar gravação";
    } else if (voiceState === "paused") {
        try { recorder.resume(); } catch { return; }
        voiceState = "recording";
        micPauseBtn.innerHTML = PAUSE_ICON;
        micPauseBtn.title = "Pausar gravação";
    }
});
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
