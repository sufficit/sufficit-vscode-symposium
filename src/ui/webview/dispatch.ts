// Inbound message dispatch from the extension host. Registers the listener on import.
import { postMessage } from "./vscode";
import { bootComplete, bootStep, bootTimer } from "./boot";
import { clearComposer, renderChips, saveCurrentComposerDraft, setBrowserOpen } from "./composer";
import { resizeInput } from "./inputSizing";
import { applyMeta } from "./meta";
import { applyEvent } from "./events";
import {
    confirmOptimisticMessage,
    endStream,
    markMessageDispatched,
    message,
    renderThinkBlock,
    resetDispatchedMessages,
    wasMessageDispatched,
    withdrawOptimisticMessage,
} from "./messages";
import { renderTool, resetToolRows } from "./tools";
import {
    renderChangedFiles,
    renderGuardrails,
    renderQueued,
    renderTasks,
    resetWorkingState,
    setChangedItems,
} from "./panels";
import { setLang, t } from "./i18n";
import { applyStaticI18n } from "./staticI18n";
import {
    renderStatusbar,
    setLastUsage,
    setLastTurn,
    setQuotaLoading,
    setSessionCostUsd,
} from "./statusbar";
import { setComposerBlocked, setLoading, setStatus } from "./status";
import { armStickyUserMessage, layout, refreshEmpty, settleAtBottom } from "./scroll";
import { svgIcon } from "./icons";
import { renderAgentPicker, refreshAgentPicker, hideAgentPicker } from "./agentPicker";
import { root, log, copySessionBtn, sendBtn, input, agentBadge, chatTitle } from "./dom";
import {
    attachments,
    activeFile,
    setActiveFile,
    setActiveFileDismissed,
    setActiveFilePinned,
    setActiveFilePreview,
    setActiveFileRange,
    setActiveModel,
    setBusy,
    setConversationRows,
    setQueued,
    setSideMode,
    setOpenInPref,
} from "./state";
import { resolveMarkdownImage } from "./markdown";

import { handleCatalogMessage } from "./dispatchCatalog";
import { applyLocalAhpFrame } from "./localAhp";
import type { AgentEvent, HistoryMessage } from "../../adapters/types";
import type { HostToWebview } from "../../protocol/chat";
import type { MetaMessageData, QueueItem, WebviewAttachment } from "./types";

let historyCycle = 0;

type DispatchMessage = HostToWebview &
    Omit<MetaMessageData, "type"> & {
        type: string;
        complete: boolean;
        id: string;
        label: string | null;
        status: "pending" | "ok" | "fail" | "warn";
        detail: string;
        lang: string;
        dataUrl?: string;
        error?: string;
        agents: Parameters<typeof renderAgentPicker>[0];
        open: boolean;
        loading: boolean;
        path: string;
        start: number;
        end: number;
        preview: boolean;
        sessionsOnly: boolean;
        items?: never[];
        held?: boolean;
        busy?: boolean;
        stale?: string[];
        attachments?: string[];
        message: HistoryMessage;
        clientMessageId?: string;
        text: string;
        files: WebviewAttachment[];
        project: string;
        event: AgentEvent;
    };

export function handleHostMessage(payload: unknown): void {
    const translated = applyLocalAhpFrame(payload);
    if (translated) {
        for (const message of translated) handleHostMessage(message);
        return;
    }
    const data = payload as DispatchMessage;
    if (handleCatalogMessage(data)) return;
    switch (data.type) {
        case "boot": {
            if (data.complete) {
                clearTimeout(bootTimer);
                bootComplete();
                break;
            }
            bootStep(data.id, data.label, data.status, data.detail);
            break;
        }
        case "setLang": {
            setLang(String(data.lang || "en"));
            applyStaticI18n();
            break;
        }
        case "markdown-image": {
            resolveMarkdownImage(
                String(data.id || ""),
                typeof data.dataUrl === "string" ? data.dataUrl : undefined,
                typeof data.error === "string" ? data.error : undefined,
            );
            break;
        }
        case "focus-input": {
            input.focus();
            break;
        }
        case "agent-picker": {
            renderAgentPicker(Array.isArray(data.agents) ? data.agents : []);
            break;
        }
        case "agent-picker-update": {
            refreshAgentPicker(Array.isArray(data.agents) ? data.agents : []);
            break;
        }
        case "meta": {
            applyMeta(data as MetaMessageData);
            break;
        }
        case "title-update": {
            chatTitle.textContent = typeof data.title === "string" ? data.title : "";
            break;
        }
        case "browser-state": {
            setBrowserOpen(!!data.open);
            break;
        }
        case "quota-loading": {
            setQuotaLoading(!!data.loading);
            renderStatusbar();
            break;
        }
        case "active-file": {
            // Editor switched or selection changed — refresh the context chip.
            // Keep it dismissed only while the same file stays active.
            if (data.path !== activeFile) {
                setActiveFileDismissed(false);
                setActiveFilePinned(false);
            }
            setActiveFile(data.path || null);
            setActiveFileRange(
                data.start && data.end ? { start: data.start, end: data.end } : null,
            );
            setActiveFilePreview(!!data.preview);
            renderChips();
            break;
        }
        case "prefs": {
            // Live preference updates (no reload needed), e.g. sessions side.
            if (typeof data.sessionsSide === "string") {
                setSideMode(data.sessionsSide);
                layout();
            }
            if (typeof data.devMode === "boolean") {
                root.classList.toggle("dev-mode", data.devMode);
            }
            if (typeof data.openIn === "string") {
                setOpenInPref(data.openIn);
                root.classList.toggle(
                    "sessions-only",
                    typeof data.sessionsOnly === "boolean"
                        ? data.sessionsOnly
                        : data.openIn === "editor" && !root.classList.contains("chat-only"),
                );
            }
            break;
        }
        case "clear": {
            historyCycle++; // invalidate a reveal already queued for the prior session
            hideAgentPicker(); // a session/dialogue is taking over the surface
            saveCurrentComposerDraft();
            clearComposer();
            setConversationRows([]);
            resetDispatchedMessages();
            log.textContent = "";
            copySessionBtn.style.display = "none";
            agentBadge.style.display = "none";
            setActiveModel("");
            setBusy(false);
            setQueued(0);
            // A new/switched dialogue has no usage yet — without this, the
            // context meter/popover keeps showing the PREVIOUS session's last
            // usage snapshot and accumulated cost until this session's own
            // first "usage" event arrives (looks like a fresh session already
            // has a full context window).
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
            break;
        }
        case "history-start": {
            // Keep the old transcript out of view while its chronological DOM
            // is rebuilt. The host sends history-end only after the replay (or
            // async adapter history load) has completed.
            historyCycle++;
            setLoading(true, "Loading session…");
            break;
        }
        case "history-end": {
            // Position the viewport at the useful tail before revealing it.
            // A second snap on the next frame covers markdown/font layout that
            // settles between DOM insertion and paint.
            const cycle = historyCycle;
            settleAtBottom(
                () => cycle === historyCycle,
                () => setLoading(false),
            );
            break;
        }
        case "queue": {
            // A send can race the host's busy state: the composer shows an
            // optimistic bubble as if dispatched, but the host actually
            // queued it. Withdraw that premature bubble so it doesn't show
            // both as "sent" AND in the Queued panel below.
            const items = (data.items || []) as unknown as QueueItem[];
            for (const it of items) {
                withdrawOptimisticMessage(it.clientMessageId);
            }
            // A rejected send never entered the real queue, so its id is
            // never among `items` above — the rejection fallback (see
            // legacyView.rejectedEnvelopeFallback) lists it here explicitly
            // so its ghost optimistic bubble still gets cleared.
            for (const id of data.stale ?? []) {
                withdrawOptimisticMessage(id);
            }
            // Anything the host already told us it dispatched is not pending,
            // whatever the payload claims. Several producers can create a
            // pending row (the AHP transport's optimistic action, the host
            // queue projection, a restored ChatState) and only some of them
            // have a reliable cleanup path — this makes the contradiction
            // unrenderable instead of relying on each of them being correct.
            const pending = items.filter((it) => !wasMessageDispatched(it.clientMessageId));
            renderQueued(pending, !!data.held);
            // The host is authoritative on busy; this "queue" message always
            // carries its current value, so a client-local desync (e.g. the
            // optimistic-bubble path above never resetting busy after a
            // withdraw) gets corrected here every time the queue changes.
            if (typeof data.busy === "boolean") {
                setBusy(data.busy);
            }
            break;
        }
        case "load-input": {
            input.value = data.text || "";
            resizeInput();
            input.focus();
            if (Array.isArray(data.attachments)) {
                for (const p of data.attachments) {
                    if (!attachments.some((a) => a.path === p)) {
                        attachments.push({ path: p, name: String(p).split("/").pop() || p });
                    }
                }
                renderChips();
            }
            saveCurrentComposerDraft();
            break;
        }
        case "append": {
            const m = data.message;
            if (m.role === "user") message("user", m.text, m.ts);
            else if (m.role === "thinking" && String(m.text || "").trim())
                renderThinkBlock(m.text ?? "");
            else if (m.role === "tool")
                renderTool(m.toolName || m.text || "", m.detail || "", {
                    input: m.input,
                    result: m.result,
                    added: m.added,
                    removed: m.removed,
                    todos: m.todos,
                    path: m.path,
                    diff: m.diff,
                });
            else message("assistant", m.text, m.ts, m.model);
            break;
        }
        case "user": {
            endStream();
            markMessageDispatched(data.clientMessageId);
            const el =
                confirmOptimisticMessage(data.clientMessageId) ||
                message("user", data.text, Date.now());
            armStickyUserMessage(el);
            if (data.attachments?.length) {
                const list = document.createElement("div");
                list.className = "msgAtts";
                for (const p of data.attachments) {
                    const a = document.createElement("span");
                    a.className = "msgAtt";
                    a.title = "Abrir " + p;
                    const ic = svgIcon("file");
                    ic.classList.add("chipIcon");
                    a.appendChild(ic);
                    // strip any " (selected lines …)" suffix for the path to open
                    // NOTE: use [(] instead of \( — this string is emitted inside a
                    // template literal, where \( collapses to ( and breaks the regex.
                    const cleanPath = String(p).replace(/ [(]selected lines.*$/, "");
                    const lbl = document.createElement("span");
                    lbl.textContent = String(p).split("/").pop() ?? "";
                    a.appendChild(lbl);
                    a.addEventListener("click", () =>
                        postMessage({ type: "open-file", path: cleanPath }),
                    );
                    list.appendChild(a);
                }
                el.appendChild(list);
            }
            setBusy(true);
            setStatus(); // a turn just started (covers queued flush)
            resizeInput();
            break;
        }
        case "attachments-picked": {
            for (const file of data.files) {
                if (!attachments.some((a) => a.path === file.path)) attachments.push(file);
            }
            renderChips();
            saveCurrentComposerDraft();
            break;
        }
        case "changed-files": {
            setChangedItems(data.items || []);
            renderChangedFiles();
            break;
        }
        case "tasks": {
            renderTasks(data.items || [], data.project || "");
            break;
        }
        case "guardrails": {
            renderGuardrails(data.items || []);
            break;
        }
        case "busy": {
            // Host-driven busy state correction (e.g. after render-log replay).
            setBusy(!!data.busy);
            setStatus();
            resizeInput();
            break;
        }
        case "event": {
            applyEvent(data.event);
            break;
        }
    }
}

window.addEventListener("message", ({ data }: MessageEvent<unknown>) => handleHostMessage(data));
