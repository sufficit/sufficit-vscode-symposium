// Inbound message dispatch from the extension host. Registers the listener on import.
import { vscode, saved } from "./vscode";
import { bootComplete, bootStep, bootTimer } from "./boot";
import { renderChips, setBrowserOpen } from "./composer";
import { append, branchBanner, endStream, message, renderError, renderStatusNotice, renderThinkBlock, streamDelta, streamThinkingDelta, resetLastMsg } from "./messages";
import { fillToolResult, renderTool } from "./tools";
import { bindWorkingSet, renderChangedFiles, renderGuardrails, renderQueued, renderTasks, renderPlan, resetWorkingState, startWorkingSet, refreshPanels, changedItems, setChangedItems } from "./panels";
import { renderAccount, renderSessions } from "./sessions";
import { renderStatusbar, openUsagePopover, setLastTurn, setLastUsage, setSessionCostUsd, sessionCostUsd } from "./statusbar";
import { setStatus, setLoading, updateSendTitle } from "./status";
import { hideCtx, openChoiceMenu, showToast } from "./menus";
import { modelLabel, modelLabels, modelValue, modelList, modelDefault, reasoningList, setModelDefault, setModelLabel, setModelLabels, setModelList, setModelValue, setPinnedModels, setReasoningDefault, setReasoningLabel, setReasoningList, setReasoningValue, buildModelMenuOpts } from "./models";
import { armStickyUserMessage, layout, refreshEmpty, scrollToBottom, nearBottom, autoScroll } from "./scroll";
import { svgIcon } from "./icons";
import { log, root, composerEl, status, chatTitle, switchAgentBtn, copySessionBtn, sendBtn, input, presencePicker, configBtn, ctxMenu, modelPicker, reasoningPicker, sendMode } from "./dom";
import { activeSessionId, currentBackend, currentBackendName, sessions, busy, activeModel, agentLabels, attachments, activeFile, commands, conversationRows, setActiveFile, setActiveFileDismissed, setActiveFilePinned, setActiveFilePreview, setActiveFileRange, setActiveModel, setActiveSessionId, setAgentLabels, setBootstrapPath, setBusy, setCommands, setConversationRows, setCurrentBackend, setCurrentBackendName, setPendingSessionSwitch, setQueued, setSessions, setSideMode, pendingSessionSwitch, permissionModes, permissionValue, permissionDefault, aiToolsAvailable, aiToolsEnabled, pendingSwitchAnchor, setPermissionModes, setPermissionValue, setPermissionDefault, setAiToolsAvailable, setAiToolsEnabled, setPendingSwitchAnchor } from "./state";

window.addEventListener("message", ({ data }) => {
    switch (data.type) {
        case "boot": {
            if (data.complete) { clearTimeout(bootTimer); bootComplete(); break; }
            bootStep(data.id, data.label, data.status, data.detail);
            break;
        }
        case "meta": {
            setSideMode(data.sessionsSide || "auto");
            // Seed the default send mode once (don't override a saved choice).
            if (data.whenBusy && !(saved && saved.sendMode)) { sendMode.value = data.whenBusy; }
            // Apply the real busy state from the host (overrides any stale busy set by render log replay).
            setBusy(!!data.busy);
            root.classList.toggle("chat-only", !!data.chatOnly);
            layout();   // apply the sessions-side now (meta sets sideMode)
            layout();
            setActiveSessionId(data.sessionId || "");
            copySessionBtn.style.display = "inline-flex";   // a session surface is open
            clearTimeout(bootTimer); bootStep("host", null, "ok"); bootStep("session", "Session ready", "ok"); bootComplete();
            startWorkingSet(activeSessionId);   // bind edited-files set to this session
            setCurrentBackend(data.backend || "");
            setCurrentBackendName(data.backendName || "");
            setAgentLabels(data.agentLabels || null);
            // Per-workspace bootstrap link on the empty screen (read-only ref).
            const bootEl = document.getElementById("bootstrapLink");
            if (data.bootstrapLink && data.bootstrapLink.path) {
                setBootstrapPath(data.bootstrapLink.path);
                bootEl.querySelector(".lbl").textContent = "Workspace bootstrap: " + (data.bootstrapLink.name || "open");
                bootEl.style.display = "inline-flex";
            } else {
                setBootstrapPath("");
                bootEl.style.display = "none";
            }
            chatTitle.textContent = (data.title ? data.title + " · " : "") + (data.backendName || data.backend);
            setBrowserOpen(!!data.browserOpen);
            setAiToolsAvailable((data.aiTools && data.aiTools.available) || []);
            setAiToolsEnabled((data.aiTools && data.aiTools.enabled) || []);
            setModelDefault(data.modelDefault || "");
            setModelLabels(data.modelLabels || {});
            setReasoningDefault(data.reasoningDefault || "");
            setModelList(data.models || []);
            setPinnedModels(data.pinnedModels || []);
            // Keep the user's chosen model across re-meta (e.g. edit-resend,
            // handoff) when it's still offered. Otherwise pick the right
            // starting model: a resumed session restores its last-used model
            // (data.sessionModel), a new session honors the configured default
            // (data.modelDefault), and only then falls back to the first model.
            if (!modelValue || (modelValue !== "default" && !modelList.includes(modelValue))) {
                if (data.resumed && data.sessionModel) {
                    setModelValue(data.sessionModel);
                } else if (modelDefault && (modelDefault === "default" || modelList.includes(modelDefault))) {
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
            setReasoningValue(reasoningList[0] || "default");
            reasoningPicker.disabled = false;
            reasoningPicker.style.display = reasoningList.length ? "" : "none";
            setReasoningLabel();
            setPermissionModes(data.permissionModes || []);
            setPermissionValue(data.permission || "default");
            setPermissionDefault(data.permission || "default");
            // Always shown (the `|| true` made the prior expression constant);
            // the config button is available regardless of permissionModes.
            configBtn.style.display = "";
            // Hand-off works for live chat dialogues and for terminal
            // sessions (whose transcript is read back from the CLI). Only
            // read-only live mirrors can't be handed off.
            switchAgentBtn.style.display = data.readOnly ? "none" : "";
            document.getElementById("composer").style.display = data.readOnly ? "none" : "flex";
            if (data.readOnly) {
                append("meta", "👁 watching live — read only (this session runs elsewhere)");
            } else if (data.terminal) {
                append("meta", "▷ terminal session — drive it here or type in the terminal panel" + (data.resumed ? " (resumed)" : ""));
            } else {
                append("meta", data.backend + (data.resumed ? " · resumed session" : " · new session"));
            }
            renderSessions();
            renderStatusbar(data);
            setActiveFile(data.activeFile || null);
            setActiveFileRange((data.activeFileStart && data.activeFileEnd) ? { start: data.activeFileStart, end: data.activeFileEnd } : null);
            setActiveFilePreview(!!data.activeFilePreview); setActiveFilePinned(false);
            setActiveFileDismissed(false); renderChips();
            setLoading(false);   // session resolved — reveal the conversation
            scrollToBottom();    // start at the latest message
            break;
        }
        case "browser-state": {
            setBrowserOpen(!!data.open);
            break;
        }
        case "active-file": {
            // Editor switched or selection changed — refresh the context chip.
            // Keep it dismissed only while the same file stays active.
            if (data.path !== activeFile) { setActiveFileDismissed(false); setActiveFilePinned(false); }
            setActiveFile(data.path || null);
            setActiveFileRange((data.start && data.end) ? { start: data.start, end: data.end } : null);
            setActiveFilePreview(!!data.preview);
            renderChips();
            break;
        }
        case "prefs": {
            // Live preference updates (no reload needed), e.g. sessions side.
            if (typeof data.sessionsSide === "string") { setSideMode(data.sessionsSide); layout(); }
            break;
        }
        case "clear": {
            setConversationRows([]);
            log.textContent = "";
            copySessionBtn.style.display = "none";
            setActiveModel(""); setBusy(false); setQueued(0);
            resetWorkingState();
            refreshEmpty();
            sendBtn.disabled = false;
            document.getElementById("composer").style.display = "flex";
            setStatus();
            break;
        }
        case "queue": {
            renderQueued(data.items || []);
            break;
        }
        case "load-input": {
            input.value = data.text || "";
            input.style.height = "auto";
            input.style.height = Math.min(input.scrollHeight, 180) + "px";
            input.focus();
            if (Array.isArray(data.attachments)) {
                for (const p of data.attachments) {
                    if (!attachments.some((a) => a.path === p)) {
                        attachments.push({ path: p, name: String(p).split("/").pop() || p });
                    }
                }
                renderChips();
            }
            break;
        }
        case "append": {
            const m = data.message;
            if (m.role === "user") message("user", m.text, m.ts);
            else if (m.role === "thinking") renderThinkBlock(m.text);
            else if (m.role === "tool") renderTool(m.toolName || m.text, m.detail || "", { input: m.input, result: m.result, added: m.added, removed: m.removed, todos: m.todos, path: m.path, diff: m.diff });
            else message("assistant", m.text, m.ts, m.model);
            break;
        }
        case "sessions": {
            setSessions(data.items);
            renderSessions();
            break;
        }
        case "account": {
            renderAccount(data.profile);
            break;
        }
        case "commands": {
            setCommands(data.items || []);
            break;
        }
        case "models": {
            // Async refresh after meta (remote discovery landed). Repopulate
            // the picker, keep the user's current pick if it survived, else
            // fall back to the first entry. Don't clobber an explicit
            // "default" selection.
            const newList = data.models || [];
            if (newList.length) {
                setModelList(newList);
                setModelLabels(data.labels || modelLabels);
                if (modelValue && modelValue !== "default" && !modelList.includes(modelValue)) {
                    setModelValue(modelList[0] || "");
                } else if (!modelValue) {
                    setModelValue(modelList[0] || "");
                }
                modelPicker.disabled = false;
                modelPicker.style.display = "";
                setModelLabel();
                setStatus();   // refresh "model: <name>" with the friendly label
            }
            // Explicit "Refresh models": give feedback and reopen the picker
            // with the fresh list (the refresh button had closed the menu).
            if (data.refreshed) {
                showToast("Models updated (" + (modelList.length || 0) + ")");
                if (!modelPicker.disabled && modelPicker.style.display !== "none") {
                    setTimeout(() => modelPicker.click(), 0);
                }
            }
            break;
        }
        case "toast": {
            if (data.text) { showToast(data.text); }
            break;
        }
        case "model-prefs": {
            if (Array.isArray(data.pinnedModels)) { setPinnedModels(data.pinnedModels); }
            if (data.modelDefault !== undefined) { setModelDefault(data.modelDefault); setModelLabel(); }
            break;
        }
        case "history": {
            resetLastMsg(); // reset so first message in loaded session always shows label
            if (data.carried && data.branchLabel) {
                branchBanner(data.branchLabel.title, data.branchLabel.detail);
            }
            for (const m of data.messages) {
                if (m.role === "user") message("user", m.text, m.ts);
                else if (m.role === "thinking") renderThinkBlock(m.text);
                else if (m.role === "tool") renderTool(m.toolName || m.text, m.detail || "", { input: m.input, result: m.result, added: m.added, removed: m.removed, todos: m.todos, path: m.path, diff: m.diff });
                else if (m.role === "error") append("error", "✖ " + m.text);
                else message("assistant", m.text, m.ts, m.model);
            }
            // carried history is a handoff replay shown inline as a
            // continuous conversation — no "stored transcript" framing.
            if (!data.carried) {
                append("meta", data.messages.length ? "— end of stored transcript —" : "(empty transcript)");
            }
            scrollToBottom();   // land at the latest message when a session opens
            break;
        }
        case "backends": {
            const items = (data.items || []).filter((b) => !b.current);
            if (!items.length) { break; }
            const anchor = pendingSwitchAnchor || switchAgentBtn;
            openChoiceMenu(
                anchor,
                items.map((b) => ({ value: b.backend, label: b.name, detail: "continue here" })),
                "",
                (v) => { vscode.postMessage({ type: "switch-backend", backend: v }); },
            );
            break;
        }
        case "session-backends": {
            // Reply to "Continue with another agent" from a session's
            // right-click menu: show the candidate backends as a submenu at
            // the spot the context menu was, then hand the session off.
            const ctx = pendingSessionSwitch;
            setPendingSessionSwitch(null);
            const items = (data.items || []).filter((b) => !b.current);
            if (!ctx || !items.length) { break; }
            ctxMenu.textContent = "";
            const head = document.createElement("div");
            head.className = "menuGroup";
            head.textContent = "Switch to model…";
            ctxMenu.appendChild(head);
            for (const b of items) {
                const mi = document.createElement("div"); mi.className = "mi";
                const ic = svgIcon("robot"); ic.classList.add("miIcon");
                mi.appendChild(ic);
                const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = b.name;
                mi.appendChild(lbl);
                mi.addEventListener("click", () => {
                    hideCtx();
                    vscode.postMessage({
                        type: "session-switch-backend",
                        sessionId: ctx.session.sessionId,
                        backend: ctx.session.backend,
                        targetBackend: b.backend,
                    });
                });
                ctxMenu.appendChild(mi);
            }
            ctxMenu.style.display = "block";
            const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
            ctxMenu.style.left = Math.max(4, Math.min(ctx.x, window.innerWidth - w - 4)) + "px";
            ctxMenu.style.top = Math.max(4, Math.min(ctx.y, window.innerHeight - h - 4)) + "px";
            break;
        }
        case "user": {
            endStream();
            const el = message("user", data.text, Date.now());
            armStickyUserMessage(el);
            if (data.attachments?.length) {
                const list = document.createElement("div");
                list.className = "msgAtts";
                for (const p of data.attachments) {
                    const a = document.createElement("span"); a.className = "msgAtt";
                    a.title = "Abrir " + p;
                    const ic = svgIcon("file"); ic.classList.add("chipIcon"); a.appendChild(ic);
                    // strip any " (selected lines …)" suffix for the path to open
                    // NOTE: use [(] instead of \( — this string is emitted inside a
                    // template literal, where \( collapses to ( and breaks the regex.
                    const cleanPath = String(p).replace(/ [(]selected lines.*$/, "");
                    const lbl = document.createElement("span"); lbl.textContent = String(p).split("/").pop();
                    a.appendChild(lbl);
                    a.addEventListener("click", () => vscode.postMessage({ type: "open-file", path: cleanPath }));
                    list.appendChild(a);
                }
                el.appendChild(list);
            }
            setBusy(true); setStatus();   // a turn just started (covers queued flush)
            break;
        }
        case "attachments-picked": {
            for (const file of data.files) {
                if (!attachments.some((a) => a.path === file.path)) attachments.push(file);
            }
            renderChips();
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
        case "event": {
            const ev = data.event;
            if (ev.kind === "thinking") streamThinkingDelta(ev.text);
            else if (ev.kind === "text") streamDelta(ev.text);
            else if (ev.kind === "status-notice") renderStatusNotice(ev.text);
            else if (ev.kind === "tool-start") { endStream(); renderTool(ev.toolName, ev.detail || "", { toolId: ev.toolId, input: ev.input, added: ev.added, removed: ev.removed, todos: ev.todos, path: ev.path }); }
            else if (ev.kind === "tool-output") fillToolResult(ev.toolId, ev.text);
            else if (ev.kind === "tool-end") fillToolResult(ev.toolId, ev.result);
            else if (ev.kind === "usage") { setLastUsage(ev); renderStatusbar(); }
            else if (ev.kind === "error") {
                // The composer's send/stop button reflects ONLY the agent's
                // turn lifecycle. A non-fatal error (ev.fatal === false) is a
                // local UI failure (e.g. failing to open a file/image) and
                // must NOT touch busy, or it would flip the button as if the
                // agent had stopped while it is still working.
                // Legacy events without fatal are treated as fatal (default),
                // preserving the old defensive behaviour for real turn errors.
                if (ev.fatal !== false) {
                    setBusy(false); sendBtn.disabled = false; setStatus();
                }
                renderError(ev.message);
            }
            else if (ev.kind === "session") {
                if (ev.model) {
                    setActiveModel(ev.model);
                    if (modelList.includes(ev.model)) { setModelValue(ev.model); setModelLabel(); }
                }
                setActiveSessionId(ev.sessionId || activeSessionId);
                bindWorkingSet(ev.sessionId);
                if (agentLabels) {
                    const parts = ["agent: " + agentLabels.agent, "model: " + (ev.model ? modelLabel(ev.model) : "default"), "backend: " + (currentBackendName || currentBackend)];
                    if (agentLabels.toolsDeclared && agentLabels.toolsDeclared.length) { parts.push("tools: " + agentLabels.toolsDeclared.join(", ")); }
                    append("meta", parts.join(" · "));
                    // only once, so re-opening a saved session won't show stale agent badges
                    setAgentLabels(null);
                }
                append("meta", "session " + ev.sessionId + (ev.model ? " · " + modelLabel(ev.model) : ""));
                setStatus();
            }
            else if (ev.kind === "turn-end") {
                setBusy(false); sendBtn.disabled = false; setStatus();
                setLastTurn({ costUsd: ev.costUsd, durationMs: ev.durationMs });
                if (ev.costUsd) { setSessionCostUsd(sessionCostUsd + ev.costUsd); }
                append("meta", "—" + (ev.costUsd ? " $" + ev.costUsd.toFixed(4) : "") + (ev.durationMs ? " " + (ev.durationMs/1000).toFixed(1) + "s" : "") + " —");
            }
            break;
        }
    }
});
