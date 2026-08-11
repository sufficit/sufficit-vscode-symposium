// meta case body extracted from dispatch.ts. Mechanical move; no behaviour change.
import { renderChips, restoreComposerDraft, setBrowserOpen } from "./composer";
import { append } from "./messages";
import { startWorkingSet } from "./panels";
import { t } from "./i18n";
import { renderSessions } from "./sessions";
import { renderStatusbar } from "./statusbar";
import { setComposerBlocked, setLoading } from "./status";
import {
    modelList,
    modelDefault,
    modelValue,
    reasoningList,
    reasoningValue,
    setModelDefault,
    setModelLabel,
    setModelLabels,
    setModelList,
    setModelValue,
    setPinnedModels,
    setReasoningDefault,
    setReasoningLabel,
    setReasoningList,
    setReasoningValue,
} from "./models";
import { scheduleLayout, scrollToBottom } from "./scroll";
import { saved } from "./vscode";
import { bootComplete, bootStep, bootTimer } from "./boot";
import {
    root,
    chatTitle,
    agentBadge,
    configBtn,
    copySessionBtn,
    modelPicker,
    reasoningPicker,
    sendMode,
    switchAgentBtn,
    remoteAccessBtn,
} from "./dom";
import { svgIcon } from "./icons";
import {
    activeSessionId,
    setAgentLabels,
    setOpenInPref,
    setActiveFile,
    setActiveFileDismissed,
    setActiveFilePinned,
    setActiveFilePreview,
    setActiveFileRange,
    setActiveSessionId,
    setAiToolsAvailable,
    setAiToolsEnabled,
    setBootstrapPath,
    setBusy,
    setCurrentBackend,
    setCurrentBackendName,
    setPermissionDefault,
    setPermissionModes,
    setPermissionValue,
    setCanSteerInline,
    setSideMode,
} from "./state";
import { preserveSelectedModel } from "./modelCatalog";
import type { MetaMessageData } from "./types";

/** Apply a `meta` message payload (session resolved / re-meta). */
export function applyMeta(data: MetaMessageData): void {
    const nextSessionId = data.sessionId || "";
    const nextBackend = data.backend || "";
    setSideMode(data.sessionsSide || "auto");
    root.classList.toggle("dev-mode", !!data.devMode);
    if (typeof data.openIn === "string") {
        setOpenInPref(data.openIn);
    }
    // Seed the default send mode once (don't override a saved choice).
    setCanSteerInline(data.canSteerInline === true);
    if (data.whenBusy && !(saved && saved.sendMode)) {
        sendMode.value = data.whenBusy;
    }
    // Apply the real busy state from the host (overrides any stale busy set by render log replay).
    setBusy(!!data.busy);
    root.classList.toggle("chat-only", !!data.chatOnly);
    root.classList.toggle("sessions-only", data.openIn === "editor" && !data.chatOnly);
    scheduleLayout(); // apply sessions-side after the host dimensions settle
    setActiveSessionId(nextSessionId);
    copySessionBtn.style.display = "inline-flex"; // a session surface is open
    clearTimeout(bootTimer);
    bootStep("host", null, "ok");
    bootStep("session", "Session ready", "ok");
    bootComplete();
    startWorkingSet(activeSessionId); // bind edited-files set to this session
    setCurrentBackend(data.backend || "");
    setCurrentBackendName(data.backendName || "");
    setAgentLabels(data.agentLabels || null);
    // Per-workspace bootstrap link on the empty screen (read-only ref).
    const bootEl = document.getElementById("bootstrapLink");
    if (bootEl && data.bootstrapLink && data.bootstrapLink.path) {
        setBootstrapPath(data.bootstrapLink.path);
        const label = bootEl.querySelector<HTMLElement>(".lbl");
        if (label) {
            label.textContent = t("chat.empty.bootstrap.label", {
                name: data.bootstrapLink.name || t("chat.empty.bootstrap.open"),
            });
        }
        bootEl.style.display = "inline-flex";
    } else if (bootEl) {
        setBootstrapPath("");
        bootEl.style.display = "none";
    }
    chatTitle.textContent = data.title || data.backendName || data.backend || "";
    // Persistent agent badge: the agent-def name when bound, else the backend
    // display name — so it's always visible which agent drives this session.
    renderAgentBadge(data);
    setBrowserOpen(!!data.browserOpen);
    setAiToolsAvailable((data.aiTools && data.aiTools.available) || []);
    setAiToolsEnabled((data.aiTools && data.aiTools.enabled) || []);
    setModelDefault(data.modelDefault || "");
    setModelLabels(data.modelLabels || {});
    setReasoningDefault(data.reasoningDefault || "");
    setModelList(
        preserveSelectedModel(data.models || [], data.resumed ? data.sessionModel || "" : ""),
    );
    setPinnedModels(data.pinnedModels || []);
    // A resumed session owns its last-used model. A new session must start
    // from the configured default, even when the previous session selected a
    // different model that is still present in the catalog.
    if (data.resumed && data.sessionModel) {
        setModelValue(data.sessionModel);
    } else if (!data.resumed) {
        setModelValue(
            modelDefault && modelDefault !== "default" && modelList.includes(modelDefault)
                ? modelDefault
                : modelList[0] || "",
        );
    } else if (!modelValue || (modelValue !== "default" && !modelList.includes(modelValue))) {
        if (modelDefault && (modelDefault === "default" || modelList.includes(modelDefault))) {
            setModelValue(modelDefault);
        } else {
            setModelValue(modelList[0] || "");
        }
    }
    // Keep the picker visible even with an empty list: the menu
    // offers a manual-entry fallback so the user can always pick a
    // model (remote discovery may have failed, e.g. 401 / no login).
    modelPicker.disabled = false;
    modelPicker.style.display = "";
    setModelLabel();
    setReasoningList(data.reasoningLevels || []);
    // Re-meta happens during edit/resend and handoff. Preserve the user's
    // reasoning effort when the refreshed backend still offers it.
    if (!reasoningValue || !reasoningList.includes(reasoningValue)) {
        setReasoningValue(reasoningList[0] || "default");
    }
    reasoningPicker.disabled = false;
    reasoningPicker.style.display = reasoningList.length ? "" : "none";
    setReasoningLabel();
    setPermissionModes(data.permissionModes || []);
    setPermissionValue(data.permission || "default");
    setPermissionDefault(data.permission || "default");
    // Always shown (the `|| true` made the prior expression constant);
    // the config button is available regardless of permissionModes.
    configBtn.style.display = "";
    // Remote access (QR) button — always visible so the user can find it.
    if (remoteAccessBtn) {
        remoteAccessBtn.style.display = "";
    }
    // Hand-off works for live chat dialogues and for terminal
    // sessions (whose transcript is read back from the CLI). Only
    // read-only live mirrors can't be handed off.
    switchAgentBtn.style.display = data.readOnly ? "none" : "";
    const codexSubagentBlocked = data.readOnlyReason === "codex-subagent";
    const blockedNotice = codexSubagentBlocked ? t("chat.composer.codexSubagent.notice") : "";
    setComposerBlocked(
        blockedNotice,
        codexSubagentBlocked
            ? t("chat.composer.codexSubagent.placeholder")
            : t("chat.composer.placeholder"),
        t("chat.composer.placeholder"),
    );
    restoreComposerDraft(nextBackend, nextSessionId);
    const composer = document.getElementById("composer");
    if (composer) {
        composer.style.display = data.readOnly && !codexSubagentBlocked ? "none" : "flex";
    }
    if (codexSubagentBlocked) {
        append("meta", blockedNotice);
    } else if (data.readOnly) {
        append("meta", "👁 watching live — read only (this session runs elsewhere)");
    } else if (data.terminal) {
        append(
            "meta",
            "▷ terminal session — drive it here or type in the terminal panel" +
                (data.resumed ? " (resumed)" : ""),
        );
    } else {
        append("meta", data.backend + (data.resumed ? " · resumed session" : " · new session"));
    }
    renderSessions();
    renderStatusbar(data);
    setActiveFile(data.activeFile || null);
    setActiveFileRange(
        data.activeFile_start && data.activeFile_end
            ? { start: data.activeFile_start, end: data.activeFile_end }
            : null,
    );
    setActiveFilePreview(!!data.activeFilePreview);
    setActiveFilePinned(false);
    setActiveFileDismissed(false);
    renderChips();
    // Resumed sessions remain hidden until the host finishes replaying their
    // stored render log/history. Revealing here used to expose the first rows
    // while they were appended, making the conversation visibly load from top
    // to bottom before jumping to the newest message.
    if (!data.historyPending) {
        scrollToBottom();
        setLoading(false);
    }
}

/** Fills the chat-header badge with the AGENT-DEF driving this session. Hidden
 *  for plain backend sessions — the backend is already shown in the statusbar,
 *  so the badge doesn't duplicate the adapter. */
function renderAgentBadge(data: MetaMessageData): void {
    const agentName = data.agentLabels && data.agentLabels.agent;
    if (!agentName) {
        agentBadge.style.display = "none";
        return;
    }
    agentBadge.textContent = "";
    const ic = svgIcon("robot");
    ic.classList.add("agentBadgeIcon");
    ic.setAttribute("aria-hidden", "true");
    agentBadge.appendChild(ic);
    agentBadge.appendChild(document.createTextNode(agentName));
    agentBadge.setAttribute("data-backend", data.backend || "");
    agentBadge.title = "Agent: " + agentName + " · " + (data.backendName || data.backend || "");
    agentBadge.style.display = "inline-flex";
}
