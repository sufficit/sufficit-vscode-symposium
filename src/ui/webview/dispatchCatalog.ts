// Inbound message dispatch from the extension host. Registers the listener on import.
import { postMessage } from "./vscode";
import { saveCurrentComposerDraft } from "./composer";
import { resizeInput } from "./inputSizing";
import {
    append,
    branchBanner,
    confirmOptimisticMessage,
    message,
    renderStatusNotice,
    renderThinkBlock,
    resetLastMsg,
} from "./messages";
import { renderTool } from "./tools";
import { renderAccount, renderSessions } from "./sessions";
import { setStatus } from "./status";
import { hideCtx, openChoiceMenu, showToast } from "./menus";
import {
    modelLabels,
    modelValue,
    modelList,
    setModelDefault,
    setModelLabel,
    setModelLabels,
    setModelList,
    setModelValue,
    setPinnedModels,
} from "./models";
import { scrollToBottom, preserveScrollOnPrepend, setHasMoreHistory } from "./scroll";
import { svgIcon } from "./icons";
import { switchAgentBtn, input, ctxMenu, modelPicker, log } from "./dom";
import {
    setCommands,
    setPendingSessionSwitch,
    setSessions,
    pendingSessionSwitch,
    pendingSwitchAnchor,
} from "./state";
import { preserveSelectedModel } from "./modelCatalog";

import type { HostToWebview } from "../../protocol/chat";

interface BackendChoice {
    backend: string;
    name: string;
    current?: boolean;
}

type HistoryToolOptions = NonNullable<Parameters<typeof renderTool>[2]>;
type HistoryMessage = HistoryToolOptions & {
    role: string;
    text: string | null;
    ts?: string | number;
    model?: string;
    clientMessageId?: string;
    toolName?: string;
    detail?: string;
    severity?: "info" | "warning" | "error";
};
type HistoryPayload = {
    carried?: boolean;
    branchLabel?: { title: string; detail: string };
    messages: HistoryMessage[];
    nextCursor?: string;
};

export function handleCatalogMessage(data: HostToWebview): boolean {
    switch (data.type) {
        case "sessions": {
            setSessions(data.items as Parameters<typeof setSessions>[0]);
            renderSessions();
            break;
        }
        case "set-input": {
            input.value = typeof data.text === "string" ? data.text : "";
            resizeInput();
            input.focus();
            saveCurrentComposerDraft();
            break;
        }
        case "account": {
            renderAccount(data.profile as Parameters<typeof renderAccount>[0]);
            break;
        }
        case "commands": {
            setCommands((data.items || []) as Parameters<typeof setCommands>[0]);
            break;
        }
        case "models": {
            // Async refresh after meta (remote discovery landed). Repopulate
            // the picker, keep the user's current pick if it survived, else
            // fall back to the first entry. Don't clobber an explicit
            // "default" selection.
            const newList = preserveSelectedModel(
                Array.isArray(data.models)
                    ? data.models.filter((model): model is string => typeof model === "string")
                    : [],
                modelValue,
            );
            if (newList.length) {
                setModelList(newList);
                setModelLabels(
                    (data.labels as Parameters<typeof setModelLabels>[0] | undefined) ||
                        modelLabels,
                );
                if (modelValue && modelValue !== "default" && !modelList.includes(modelValue)) {
                    setModelValue(modelList[0] || "");
                } else if (!modelValue) {
                    setModelValue(modelList[0] || "");
                }
                modelPicker.disabled = false;
                modelPicker.style.display = "";
                setModelLabel();
                setStatus(); // refresh "model: <name>" with the friendly label
            }
            // Explicit "Refresh models": give feedback and reopen the picker
            // with the fresh list (the refresh button had closed the menu).
            if (data.refreshed) {
                showToast(
                    newList.length
                        ? "Models updated (" + newList.length + ")"
                        : "No models returned by this backend — check its endpoint URL and API key.",
                );
                if (
                    newList.length &&
                    !modelPicker.disabled &&
                    modelPicker.style.display !== "none"
                ) {
                    setTimeout(() => modelPicker.click(), 0);
                }
            }
            break;
        }
        case "toast": {
            if (data.text) {
                showToast(String(data.text));
            }
            break;
        }
        case "model-prefs": {
            if (Array.isArray(data.pinnedModels)) {
                setPinnedModels(data.pinnedModels);
            }
            if (data.modelDefault !== undefined) {
                setModelDefault(String(data.modelDefault));
                setModelLabel();
            }
            break;
        }
        case "compression-preset-set": {
            showToast("Compression preset updated.");
            break;
        }
        case "session-model-updated": {
            if (data.model) {
                setModelValue(String(data.model));
                setModelLabel();
            }
            break;
        }
        case "history": {
            const history = data as typeof data & HistoryPayload;
            resetLastMsg(); // reset so first message in loaded session always shows label
            if (history.carried && history.branchLabel) {
                branchBanner(history.branchLabel.title, history.branchLabel.detail);
            }
            for (const m of history.messages) {
                if (m.role === "user") {
                    if (!confirmOptimisticMessage(m.clientMessageId)) {
                        message("user", m.text, m.ts);
                    }
                } else if (m.role === "thinking" && String(m.text || "").trim())
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
                else if (m.role === "error") append("error", "✖ " + m.text);
                else if (m.role === "status-notice" && m.text)
                    // No action passed: the live "Continue" affordance a
                    // paused tool loop had would be stale by replay time —
                    // this is just the historical record that it happened.
                    renderStatusNotice(m.text, undefined, m.severity);
                else message("assistant", m.text, m.ts, m.model);
            }
            // carried history is a handoff replay shown inline as a
            // continuous conversation — no "stored transcript" framing.
            if (!history.carried) {
                append(
                    "meta",
                    history.messages.length ? "— end of stored transcript —" : "(empty transcript)",
                );
            }
            // Signal scroll-up pagination availability for lazy-loaded backends.
            setHasMoreHistory(!!history.nextCursor);
            scrollToBottom();
            break;
        }
        case "history-prepend": {
            // Scroll-up pagination: older turns arrived. Render the legacy
            // messages normally (each appends to the log), then move the newly
            // added block to the top while preserving the user's scroll position.
            const payload = data as typeof data & { messages?: HostToWebview[] };
            const prependMessages = Array.isArray(payload.messages) ? payload.messages : [];
            if (prependMessages.length === 0) break;
            const beforeCount = log.childElementCount;
            for (const m of prependMessages) {
                handleCatalogMessage(m);
            }
            const afterCount = log.childElementCount;
            const addedCount = afterCount - beforeCount;
            if (addedCount <= 0) break;
            preserveScrollOnPrepend(() => {
                // Move the last `addedCount` children to the top of the log.
                const children = Array.from(log.children);
                const added = children.slice(children.length - addedCount);
                const fragment = document.createDocumentFragment();
                for (const el of added) fragment.appendChild(el);
                log.insertBefore(fragment, log.firstChild);
            });
            setHasMoreHistory(true);
            break;
        }
        case "backends": {
            const items = ((data.items || []) as BackendChoice[]).filter((b) => !b.current);
            if (!items.length) {
                break;
            }
            const anchor = pendingSwitchAnchor || switchAgentBtn;
            openChoiceMenu(
                anchor,
                items.map((b) => ({ value: b.backend, label: b.name, detail: "continue here" })),
                "",
                (v) => {
                    postMessage({ type: "switch-backend", backend: v });
                },
            );
            break;
        }
        case "session-backends": {
            // Reply to "Switch adapter" from a session's
            // right-click menu: show the candidate backends as a submenu at
            // the spot the context menu was, then hand the session off.
            const ctx = pendingSessionSwitch;
            setPendingSessionSwitch(null);
            const items = ((data.items || []) as BackendChoice[]).filter((b) => !b.current);
            if (!ctx || !items.length) {
                break;
            }
            ctxMenu.textContent = "";
            const head = document.createElement("div");
            head.className = "menuGroup";
            head.textContent = "Switch to adapter…";
            ctxMenu.appendChild(head);
            for (const b of items) {
                const mi = document.createElement("div");
                mi.className = "mi";
                const ic = svgIcon("robot");
                ic.classList.add("miIcon");
                mi.appendChild(ic);
                const lbl = document.createElement("span");
                lbl.className = "milbl";
                lbl.textContent = b.name;
                mi.appendChild(lbl);
                mi.addEventListener("click", () => {
                    hideCtx();
                    postMessage({
                        type: "session-switch-backend",
                        sessionId: ctx.session.sessionId,
                        backend: ctx.session.backend,
                        targetBackend: b.backend,
                    });
                });
                ctxMenu.appendChild(mi);
            }
            ctxMenu.style.display = "block";
            const w = ctxMenu.offsetWidth,
                h = ctxMenu.offsetHeight;
            ctxMenu.style.left = Math.max(4, Math.min(ctx.x, window.innerWidth - w - 4)) + "px";
            ctxMenu.style.top = Math.max(4, Math.min(ctx.y, window.innerHeight - h - 4)) + "px";
            break;
        }
        default:
            return false;
    }
    return true;
}
