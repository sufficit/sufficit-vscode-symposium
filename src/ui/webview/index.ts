import { postMessage, saved, saveState } from "./vscode";
import type { DroppedFilePayload } from "../../protocol/chat";
import "./dispatch";
import "./configMenu";
import "./sessionsPaneResize";
import { t } from "./i18n";
import { renderSessions, openSessionsFilterMenu, backendLabel } from "./sessions";
import { updateSendTitle, setStatus, setLoading } from "./status";
import { openChoiceMenu, showToast, hideCtx } from "./menus";
import {
    currentBackend,
    activeSessionId,
    sessions,
    showArchived,
    bootstrapPath,
    setShowArchived,
    setSessionSearchTerm,
    autonomyValue,
    setAutonomyValue,
    setPendingSwitchAnchor,
} from "./state";
import { relTime } from "./format";
import { refreshEmpty } from "./scroll";
import {
    sendMode,
    chatTitle,
    sessionFilterBtn,
    sessionRefreshBtn,
    sessionsBackBtn,
    sessionSearch,
    switchAgentBtn,
    copySessionBtn,
    presencePicker,
    remoteAccessBtn,
    composerEl,
    ctxMenu,
    addBrowserPage,
} from "./dom";
import { copyText } from "./markdown";
import { svgIcon } from "./icons";
import { applyStaticI18n } from "./staticI18n";
window.addEventListener("error", (e) => {
    const bh = document.getElementById("bootHint");
    if (bh) {
        bh.textContent = "❌ " + (e.message || "JS error") + " @" + (e.lineno || "?");
        bh.style.color = "var(--vscode-errorForeground, #f14c4c)";
        bh.style.opacity = "1";
    }
    try {
        postMessage({
            type: "webview-error",
            message: (e.message || "error") + " @" + (e.lineno || "?"),
        });
    } catch (reportError) {
        console.error("[symposium webview] failed to report an error", reportError);
    }
});

document.getElementById("newSessionBtn")?.addEventListener("click", () => {
    setLoading(true, "Starting…");
    postMessage({ type: "new-session" });
});
document.getElementById("headerSessionsBtn")?.addEventListener("click", (event) => {
    // The document-level click handler closes menus. Keep this opening click
    // from bubbling into it and immediately hiding the session popover.
    event.stopPropagation();
    const anchor = event.currentTarget as HTMLButtonElement;
    const recent = [...sessions]
        .filter((session) => !session.archived && !session.deleting)
        .sort((a, b) => {
            if (!!a.pinned !== !!b.pinned) {
                return a.pinned ? -1 : 1;
            }
            return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
        });
    if (!recent.length) {
        showToast("No Symposium sessions found.");
        postMessage({ type: "refresh-sessions" });
        return;
    }
    openChoiceMenu(
        anchor,
        recent.map((session) => ({
            value: `${session.backend}:${session.sessionId}`,
            label: `${session.pinned ? "● " : ""}${session.title || "Untitled session"}`,
            detail: [
                session.backendName || backendLabel(session.backend),
                relTime(session.updatedAt),
            ]
                .filter(Boolean)
                .join("  ·  "),
            title: session.cwd || session.sessionId,
        })),
        `${currentBackend}:${activeSessionId}`,
        (value: string) => {
            hideCtx();
            const split = value.indexOf(":");
            postMessage({
                type: "open-session",
                backend: value.slice(0, split),
                sessionId: value.slice(split + 1),
            });
        },
        { search: true, placement: "below", align: "right" },
    );
});
document.getElementById("headerNewSessionBtn")?.addEventListener("click", () => {
    setLoading(true, "Starting…");
    postMessage({ type: "new-editor-session" });
});
document.getElementById("emptyNewSession")?.addEventListener("click", () => {
    setLoading(true, "Starting…");
    postMessage({ type: "new-session" });
});
document.getElementById("bootstrapLink")?.addEventListener("click", () => {
    if (bootstrapPath) {
        postMessage({ type: "open-file", path: bootstrapPath });
    }
});
document.getElementById("archToggle")?.addEventListener("click", () => {
    setShowArchived(!showArchived);
    renderSessions();
});
sessionFilterBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // Toggle: clicking the funnel again closes the open filter menu.
    if (ctxMenu.style.display === "block" && ctxMenu.classList.contains("sessionFiltersMenu")) {
        hideCtx();
    } else {
        openSessionsFilterMenu(sessionFilterBtn);
    }
});
if (sessionRefreshBtn) {
    sessionRefreshBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        postMessage({ type: "refresh-sessions" });
    });
}
if (sessionsBackBtn) {
    sessionsBackBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (document.getElementById("root")?.classList.contains("listOpen")) {
            document.getElementById("root")?.classList.remove("listOpen");
            return;
        }
        postMessage({ type: "open-active-session" });
    });
}
if (sessionSearch) {
    sessionSearch.addEventListener("input", () => {
        setSessionSearchTerm(sessionSearch.value);
        renderSessions();
    });
}
renderSessions(); // initial placeholder while the host loads the session tree

// Persisted UI state (send mode + sessions pane width).
if (saved.sendMode) {
    sendMode.value = saved.sendMode;
}

// Parent session ids whose subagent children are collapsed in the list.

// Split send-button: caret opens a small menu to choose Send/Queue/Steer.
// Each mode has its own icon and its own keyboard shortcut (like the
// native chat): Enter sends with the selected default mode, while the
// modifier shortcuts force a specific mode regardless of the default.
updateSendTitle();

// ---- themed dropdowns replacing native <select> ----
// options: [{ value, label, group?, detail?, title? }]; opts: { search?: bool }

// Switch agent — hand this dialogue off to another backend in place. The
// list of candidates is requested live (it depends on the current backend),
// then shown as a menu anchored to the header button.
switchAgentBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setPendingSwitchAnchor(switchAgentBtn);
    postMessage({ type: "list-backends" });
});

// Copy the active session's "id title" to the clipboard, with a toast.
// Wired to BOTH the header copy icon AND clicking the title text itself.
function copySession(ev?: Event): void {
    if (ev) {
        ev.stopPropagation();
    }
    const title = (chatTitle.textContent || "").trim();
    const text = [activeSessionId, title].filter(Boolean).join(" ");
    if (!text) {
        return;
    }
    copyText(text, () => showToast(t("chat.copy.toast")));
}
copySessionBtn.addEventListener("click", copySession);
// Clicking the title text also copies (more discoverable than the icon).
chatTitle.style.cursor = "pointer";
chatTitle.title = t("chat.copy.titleTooltip");
chatTitle.addEventListener("click", copySession);

// Presence / autonomy — quick toggle in the composer, changeable any time
// (NOT locked while busy); the value is read on every send.
const presenceMenu = () => [
    {
        value: "present",
        label: t("chat.presence.present"),
        detail: t("chat.presence.present.detail"),
        title: t("chat.presence.present.menuTitle"),
    },
    {
        value: "away",
        label: t("chat.presence.away"),
        detail: t("chat.presence.away.detail"),
        title: t("chat.presence.away.menuTitle"),
    },
];
const presenceLbl = presencePicker.querySelector<HTMLElement>(".lbl");
const presenceIcon = presencePicker.querySelector<HTMLElement>(".picon");
function setPresenceLabel() {
    const away = autonomyValue === "away";
    if (presenceLbl) {
        presenceLbl.textContent = away ? t("chat.presence.away") : t("chat.presence.present");
    }
    if (presenceIcon) {
        presenceIcon.innerHTML = "";
        presenceIcon.appendChild(svgIcon(away ? "robot" : "eye"));
    }
    presencePicker.classList.toggle("away", away);
    presencePicker.title =
        (away ? t("chat.presence.away.tooltip") : t("chat.presence.present.tooltip")) +
        t("chat.presence.changeSuffix");
}
presencePicker.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if ((presencePicker as HTMLButtonElement).disabled) {
        return;
    }
    openChoiceMenu(presencePicker, presenceMenu(), autonomyValue, (v) => {
        setAutonomyValue(v);
        saveState({ autonomy: v });
        setPresenceLabel();
    });
});
// ICONS is imported (no temporal dead zone), so paint the presence icon now.
setPresenceLabel();
// Re-localize the presence control when the host pushes the UI language.
// Handle voice preferences from host
window.addEventListener("message", (e) => {
    const data = e.data;
    if (!data) return;

    if (data.type === "setLang") {
        setPresenceLabel();
    } else if (data.type === "setVoicePreferences") {
        window.voicePreferences = data.preferences;
    }
});

// ---- plan / todo (pinned above the edited-files set, per session) ----

// Per-session actions, shown as hover icons on the right and in the
// right-click menu. Each posts a session-action the extension handles.
// Terminal + watch-live are CLI-only features; API backends have no executable.

// Remembers the session + anchor while the backend submenu is requested,
// so the "backends" reply (async) can be shown as a follow-up menu.

// Relative time like the native viewer ("now", "5 min ago", "1 day ago").
// Recency bucket header label.

// Drop the dragged pinned session before the target, persist the new order.

// Right-click menu for a file referenced by a tool row.

// Footer status bar: cwd · backend · permission/mode (like the native bar).
// Meter color tracks fullness like Copilot: normal < 75%, amber 75–90%, red ≥ 90%.

// ---- edit & resend from an earlier user message ----
// Most recent user turn (index + raw text), for "edit & retry".

// ---- slash-command autocomplete ----

// While a turn runs the button stops it; otherwise it sends.
if (addBrowserPage) {
    addBrowserPage.style.display = "none"; // shown only while a Simple Browser is open
    addBrowserPage.addEventListener("click", () => postMessage({ type: "attach-browser-page" }));
}

// Remote access: opens the QR panel so the user can scan and open on a phone.
if (remoteAccessBtn) {
    remoteAccessBtn.addEventListener("click", () => postMessage({ type: "remote-access" }));
}

// Paste: images become attachments (written to a temp file by the
// extension); text falls through to the textarea natively.
// Single listener on the document (paste bubbles up from the textarea);
// adding it to both the input and the document fired it twice.

// Drag & drop files onto the composer → attachments (parity with paste).
// OS files arrive as dataTransfer.files; VS Code Explorer drags as a
// text/uri-list of file:// URIs. The extension writes/resolves them and
// posts attachments-picked back, which adds the chips.
const dragRelevant = (dt: DataTransfer | null): boolean =>
    !!dt && Array.from(dt.types || []).some((t) => t === "Files" || t === "text/uri-list");
["dragenter", "dragover"].forEach((evName) =>
    composerEl.addEventListener(evName, (e) => {
        const dragEvent = e as DragEvent;
        if (!dragRelevant(dragEvent.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (dragEvent.dataTransfer) {
            dragEvent.dataTransfer.dropEffect = "copy";
        }
        composerEl.classList.add("dragover");
    }),
);
composerEl.addEventListener("dragleave", (e) => {
    const related = e.relatedTarget as Node | null;
    if (!related || !composerEl.contains(related)) {
        composerEl.classList.remove("dragover");
    }
});
composerEl.addEventListener("drop", (e) => {
    const dropEvent = e as DragEvent;
    if (!dropEvent.dataTransfer) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    composerEl.classList.remove("dragover");
    const files = Array.from(dropEvent.dataTransfer.files || []);
    if (files.length) {
        const payloads: DroppedFilePayload[] = [];
        let pending = files.length;
        const flush = () => {
            if (--pending === 0 && payloads.length) {
                postMessage({ type: "drop-files", files: payloads });
            }
        };
        files.forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
                payloads.push({
                    name: file.name,
                    mime: file.type,
                    data: String(reader.result).split(",")[1] || "",
                });
                flush();
            };
            reader.onerror = () => flush();
            reader.readAsDataURL(file);
        });
        return;
    }
    const uriList = dropEvent.dataTransfer.getData("text/uri-list");
    if (uriList) {
        const uris = uriList
            .split(/\r?\n/)
            .map((u) => u.trim())
            .filter((u) => u && u.charAt(0) !== "#");
        if (uris.length) {
            postMessage({ type: "drop-uris", uris });
            return;
        }
    }
    const plain = (dropEvent.dataTransfer.getData("text/plain") || "").trim();
    if (plain && (plain.startsWith("file:") || plain.startsWith("/"))) {
        const uris = plain
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => (s.startsWith("file:") ? s : "file://" + s));
        postMessage({ type: "drop-uris", uris });
    }
});

setStatus();
refreshEmpty(); // show the placeholder until a conversation loads
applyStaticI18n(); // paint default/EN labels now; setLang re-applies later
// Handshake: the extension queues everything until this script is live,
// so meta/history posted right after construction are never lost.
postMessage({ type: "ready" });
