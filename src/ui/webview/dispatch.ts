// Inbound message dispatch from the extension host. Registers the listener on import.
import { bootComplete, bootStep, bootTimer } from "./boot";
import { clearComposer, renderChips, saveCurrentComposerDraft, setBrowserOpen } from "./composer";
import { resizeInput } from "./inputSizing";
import { applyMeta } from "./meta";
import { applyEvent } from "./events";
import { message, renderThinkBlock } from "./messages";
import { renderTool } from "./tools";
import { renderChangedFiles, renderGuardrails, renderTasks, setChangedItems } from "./panels";
import { setLang } from "./i18n";
import { applyStaticI18n } from "./staticI18n";
import { renderStatusbar, setQuotaLoading } from "./statusbar";
import { setLoading, setStatus } from "./status";
import { layout, settleAtBottom } from "./scroll";
import { renderAgentPicker, refreshAgentPicker, hideAgentPicker } from "./agentPicker";
import { root, copySessionBtn, input, agentBadge, chatTitle } from "./dom";
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
    setSideMode,
    setOpenInPref,
} from "./state";
import { resolveMarkdownImage } from "./markdown";

import {
    beginCatalogHistoryCycle,
    handleCatalogMessage,
    whenCatalogHistoryIdle,
} from "./dispatchCatalog";
import { applyLocalAhpFrame, whenAhpChatRenderIdle } from "./localAhp";
import { resetAhpChatRendering } from "./ahpChatView";
import type { AgentEvent, HistoryMessage } from "../../adapters/types";
import type { HostToWebview } from "../../protocol/chat";
import type { MetaMessageData, QueueItem, WebviewAttachment } from "./types";
import { renderQueueView, renderUserTurn, resetConversationView } from "./conversationView";

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
    if (applyLocalAhpFrame(payload)) return;
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
            if (typeof data.chatOnly === "boolean") {
                root.classList.toggle("chat-only", data.chatOnly);
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
            beginCatalogHistoryCycle();
            resetAhpChatRendering();
            hideAgentPicker(); // a session/dialogue is taking over the surface
            saveCurrentComposerDraft();
            clearComposer();
            copySessionBtn.style.display = "none";
            agentBadge.style.display = "none";
            setActiveModel("");
            resetConversationView();
            break;
        }
        case "history-start": {
            // Keep the old transcript out of view while its chronological DOM
            // is rebuilt. The host sends history-end only after the replay (or
            // async adapter history load) has completed.
            historyCycle++;
            beginCatalogHistoryCycle();
            setLoading(true, "Loading session…");
            break;
        }
        case "history-end": {
            // Position the viewport at the useful tail before revealing it.
            // A second snap on the next frame covers markdown/font layout that
            // settles between DOM insertion and paint.
            const cycle = historyCycle;
            void Promise.all([whenCatalogHistoryIdle(), whenAhpChatRenderIdle()]).then(() => {
                if (cycle !== historyCycle) return;
                settleAtBottom(
                    () => cycle === historyCycle,
                    () => setLoading(false),
                );
            });
            break;
        }
        case "queue": {
            renderQueueView(
                (data.items || []) as unknown as QueueItem[],
                !!data.held,
                data.busy,
                data.stale,
            );
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
            else message("assistant", m.text, m.ts, m.model, m.reasoning);
            break;
        }
        case "user": {
            renderUserTurn(
                data.text,
                data.attachments,
                data.clientMessageId,
                typeof data.ts === "string" || typeof data.ts === "number" ? data.ts : undefined,
            );
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
