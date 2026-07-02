// Inbound message dispatch from the extension host. Registers the listener on import.
import { vscode } from "./vscode";
import { bootComplete, bootStep, bootTimer } from "./boot";
import { renderChips, setBrowserOpen } from "./composer";
import { applyMeta } from "./meta";
import { applyEvent } from "./events";
import { append, branchBanner, endStream, message, renderThinkBlock, resetLastMsg } from "./messages";
import { renderTool } from "./tools";
import { renderChangedFiles, renderGuardrails, renderQueued, renderTasks, renderPlan, resetWorkingState, refreshPanels, changedItems, setChangedItems } from "./panels";
import { renderAccount, renderSessions } from "./sessions";
import { setLang, t } from "./i18n";
import { applyStaticI18n } from "./staticI18n";
import { openUsagePopover } from "./statusbar";
import { setStatus, updateSendTitle } from "./status";
import { hideCtx, openChoiceMenu, showToast } from "./menus";
import { modelLabels, modelValue, modelList, modelDefault, setModelDefault, setModelLabel, setModelLabels, setModelList, setModelValue, setPinnedModels, buildModelMenuOpts } from "./models";
import { armStickyUserMessage, layout, refreshEmpty, scrollToBottom, nearBottom, autoScroll } from "./scroll";
import { svgIcon } from "./icons";
import { log, composerEl, status, switchAgentBtn, copySessionBtn, sendBtn, input, presencePicker, ctxMenu, modelPicker } from "./dom";
import { sessions, busy, activeModel, attachments, activeFile, commands, conversationRows, setActiveFile, setActiveFileDismissed, setActiveFilePinned, setActiveFilePreview, setActiveFileRange, setActiveModel, setBusy, setCommands, setConversationRows, setPendingSessionSwitch, setQueued, setSessions, setSideMode, pendingSessionSwitch, permissionModes, permissionValue, permissionDefault, aiToolsAvailable, aiToolsEnabled, pendingSwitchAnchor, setPendingSwitchAnchor } from "./state";

window.addEventListener("message", ({ data }) => {
    switch (data.type) {
        case "boot": {
            if (data.complete) { clearTimeout(bootTimer); bootComplete(); break; }
            bootStep(data.id, data.label, data.status, data.detail);
            break;
        }
        case "setLang": { setLang(String(data.lang || "en")); applyStaticI18n(); break; }
        case "meta": { applyMeta(data); break; }
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
        case "set-input": {
            input.value = data.text || "";
            input.focus();
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
                showToast(newList.length
                    ? "Models updated (" + newList.length + ")"
                    : "No models returned by this backend — check its endpoint URL and API key.");
                if (newList.length && !modelPicker.disabled && modelPicker.style.display !== "none") {
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
        case "session-model-updated": {
            if (data.model) { setModelValue(data.model); setModelLabel(); }
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
            scrollToBottom();
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
            // Reply to "Switch adapter" from a session's
            // right-click menu: show the candidate backends as a submenu at
            // the spot the context menu was, then hand the session off.
            const ctx = pendingSessionSwitch;
            setPendingSessionSwitch(null);
            const items = (data.items || []).filter((b) => !b.current);
            if (!ctx || !items.length) { break; }
            ctxMenu.textContent = "";
            const head = document.createElement("div");
            head.className = "menuGroup";
            head.textContent = "Switch to adapter…";
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
        case "busy": {
            // Host-driven busy state correction (e.g. after render-log replay).
            setBusy(!!data.busy);
            setStatus();
            break;
        }
        case "event": { applyEvent(data.event); break; }
    }
});
