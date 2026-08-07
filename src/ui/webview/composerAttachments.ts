// Session-scoped drafts, attachment chips, and send-mode controls.
import { postMessage, saveState } from "./vscode";
import { input, sendMode, sendGroup, sendCaret, stopBtn, chips, ctxMenu } from "./dom";
import {
    attachments,
    activeFile,
    activeFileRange,
    activeFileDismissed,
    activeFilePreview,
    activeFilePinned,
    activeSessionId,
    busy,
    currentBackend,
    getComposerDraft,
    setAttachments,
    setActiveFileDismissed,
    setActiveFilePinned,
    setComposerDraft,
} from "./state";
import { setStatus, updateSendTitle, MODE_LABELS, MODE_KBD, MODE_ICONS, MODE_DESC } from "./status";
import { svgIcon } from "./icons";
import { refreshPanelLayout } from "./panelBridge";
import { resizeInput } from "./inputSizing";

export function activeFileSuffix() {
    return activeFileRange ? ":" + activeFileRange.start + "-" + activeFileRange.end : "";
}
export function composerSessionKey(backend = currentBackend, sessionId = activeSessionId): string {
    return sessionId ? backend + "::" + sessionId : "";
}
export function saveCurrentComposerDraft(): void {
    setComposerDraft(composerSessionKey(), input.value, attachments);
}
export function restoreComposerDraft(backend: string, sessionId: string): void {
    const draft = getComposerDraft(composerSessionKey(backend, sessionId));
    input.value = draft?.text || "";
    setAttachments((draft?.attachments || []).map((a) => ({ path: a.path, name: a.name })));
    resizeInput();
    renderChips();
    setStatus();
}
sendMode.addEventListener("change", () => saveState({ sendMode: sendMode.value }));
stopBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!busy) {
        return;
    }
    sendGroup.classList.add("stopping");
    postMessage({ type: "cancel" });
});
sendCaret.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ctxMenu.textContent = "";
    for (const mode of ["redirect", "queue", "steer"]) {
        const mi = document.createElement("div");
        mi.className = "mi";
        mi.title = MODE_DESC[mode];
        const tick = document.createElement("span");
        tick.className = "tick";
        tick.textContent = sendMode.value === mode ? "✓" : "";
        const ic = document.createElement("span");
        ic.className = "miIcon";
        ic.innerHTML = MODE_ICONS[mode];
        const lbl = document.createElement("span");
        lbl.className = "milbl";
        lbl.textContent = MODE_LABELS[mode];
        const kbd = document.createElement("span");
        kbd.className = "mikbd";
        kbd.textContent = MODE_KBD[mode];
        mi.append(tick, ic, lbl, kbd);
        mi.addEventListener("click", () => {
            sendMode.value = mode;
            saveState({ sendMode: mode });
            updateSendTitle();
        });
        ctxMenu.appendChild(mi);
    }
    ctxMenu.style.display = "block";
    const r = sendCaret.getBoundingClientRect();
    const w = ctxMenu.offsetWidth,
        h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, r.right - w) + "px";
    ctxMenu.style.top = Math.max(4, r.top - h - 4) + "px";
});
export function makeChip(
    label: string,
    fullPath: string,
    onRemove: () => void,
    active: boolean,
    openPath: string | null,
): HTMLSpanElement {
    const chip = document.createElement("span");
    chip.className = "chip" + (active ? " activeChip" : "");
    chip.title = openPath ? "Abrir " + openPath : fullPath;
    const ic = svgIcon("file");
    ic.classList.add("chipIcon");
    chip.appendChild(ic);
    const lb = document.createElement("span");
    lb.className = "lbl";
    lb.textContent = label;
    chip.appendChild(lb);
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.addEventListener("click", (e) => {
        e.stopPropagation();
        onRemove();
    });
    chip.appendChild(x);
    // Click the chip body (not ✕) to open/preview the file.
    if (openPath) {
        chip.classList.add("clickable");
        chip.addEventListener("click", (e) => {
            const target = e.target as HTMLElement | null;
            if (target?.classList.contains("x")) {
                return;
            }
            postMessage({ type: "open-file", path: openPath });
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
        const base =
            (activeFile.split("/").filter(Boolean).pop() || activeFile) + activeFileSuffix();
        const isSuggestion = activeFilePreview && !activeFilePinned;
        // Suggestion chip clicks to PIN; an attached chip clicks to OPEN.
        const chip = makeChip(
            base,
            activeFile + activeFileSuffix(),
            () => {
                setActiveFileDismissed(true);
                renderChips();
            },
            !isSuggestion,
            isSuggestion ? null : activeFile,
        );
        if (isSuggestion) {
            chip.classList.add("suggestChip");
            chip.title =
                activeFile + activeFileSuffix() + " — preview (clique para anexar ao contexto)";
            chip.addEventListener("click", (e) => {
                const target = e.target as HTMLElement | null;
                if (target?.classList.contains("x")) {
                    return;
                }
                setActiveFilePinned(true);
                renderChips();
            });
        }
        chips.appendChild(chip);
    }
    // Skip a manual attachment that's ALSO the active-file chip above (same
    // path shown twice for one file — see send()'s matching guard).
    for (const file of attachments) {
        if (file.path === activeFile && !activeFileDismissed) {
            continue;
        }
        chips.appendChild(
            makeChip(
                file.name,
                file.path,
                () => {
                    setAttachments(attachments.filter((a) => a.path !== file.path));
                    renderChips();
                    saveCurrentComposerDraft();
                },
                false,
                file.path,
            ),
        );
    }
    // Attached files are a panel tab now — refresh the strip so its count/icon
    // tracks what's attached.
    refreshPanelLayout();
}
