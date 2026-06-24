import { vscode, saved, saveState } from "./vscode";
import { activeFileSuffix, makeChip, renderChips, markEditing, lastUserRow, beginEdit, cancelEdit, retryLast, send, slashActive, updateSlash, renderSlash, acceptSlash, setBrowserOpen, handlePaste } from "./composer";
import { resetLastMsg, renderError, append, branchBanner, message, streamDelta, endStream, renderThinkBlock, streamThinkingDelta, bumpToolGroup } from "./messages";
import { renderTool, fillToolResult } from "./tools";
import { renderStatusbar, openUsagePopover, setLastUsage, setLastTurn, sessionCostUsd, setSessionCostUsd } from "./statusbar";
import "./dispatch";
import { renderTodos, renderPlan, renderTasks, renderGuardrails, renderQueued, renderChangedFiles, refreshPanels, resetWorkingState, startWorkingSet, bindWorkingSet, panelDefs } from "./panels";
import { bootStep, bootComplete, renderBootStep, bootTimer } from "./boot";
import { renderSessions, renderAccount, renderSessionItem, groupHeader, toggleCollapsed, dropPinnedOn, openSessionsFilterMenu } from "./sessions";
import { isMac, MOD, ALT, MODE_LABELS, MODE_KBD, MODE_ICONS, MODE_DESC, STOP_ICON, updateSendTitle, setStatus, syncProgress, setLoading } from "./status";
import { modelValue, reasoningValue, modelList, reasoningList, reasoningDefault, modelDefault, modelLabels, pinnedModels, modelLabel, defLabel, setModelLabel, setReasoningLabel, buildModelMenuOpts, setModelValue, setModelList, setReasoningValue, setReasoningList, setReasoningDefault, setModelDefault, setModelLabels, setPinnedModels } from "./models";
import { openChoiceMenu, showToast, showCtx, showFileMenu, showTip, hideTip, hideCtx, placeTip, actionsFor, runAction } from "./menus";
import { attachments, activeFile, activeFileRange, activeFileDismissed, activeFilePreview, activeFilePinned, currentBackend, currentBackendName, agentLabels, activeModel, activeSessionId, busy, queued, loading, sessions, showArchived, bootstrapPath, setAttachments, setActiveFile, setActiveFileRange, setActiveFileDismissed, setActiveFilePreview, setActiveFilePinned, setCurrentBackend, setCurrentBackendName, setAgentLabels, setActiveModel, setActiveSessionId, setBusy, setQueued, setLoadingFlag, setSessions, setShowArchived, setSessionSearchTerm, setBootstrapPath, setSideMode, pendingSessionSwitch, setPendingSessionSwitch, conversationRows, commands, setConversationRows, setCommands, autonomyValue, setAutonomyValue, permissionModes, permissionValue, permissionDefault, aiToolsAvailable, aiToolsEnabled, pendingSwitchAnchor, setPermissionModes, setPermissionValue, setPermissionDefault, setAiToolsAvailable, setAiToolsEnabled, setPendingSwitchAnchor } from "./state";
import { allDigits, middleEllipsisPath, relWhen, relTime, bucket, fmtTokens, usageColor } from "./format";
import { layout, nearBottom, autoScroll, scrollToBottom, updateScrollBtn, refreshEmpty, sideIsRight, lastAutoScroll } from "./scroll";
import { root, log, input, chips, addContext, modelPicker, reasoningPicker, sendMode, sendBtn, status, sessionsList, chatTitle, sessionFilterBtn, sessionSearch, listToggle, sendCaret, sendIcon, sendGroup, stopBtn, switchAgentBtn, tipEl, copySessionBtn, presencePicker, configBtn, sessionsPane, resizer, progress, composerEl, planEl, tasksEl, guardrailsEl, queuedEl, changedFiles, panelBody, panelTabs, attachedPanel, ctxMenu, statusbar, slash, addBrowserPage, bootStepsEl, bootHintEl } from "./dom";
import { renderMarkdown, inline } from "./markdown";
import { ICONS, svgIcon, fileIcon } from "./icons";
    window.addEventListener("error", (e) => {
        const bh = document.getElementById("bootHint");
        if (bh) { bh.textContent = "❌ " + (e.message || "JS error") + " @" + (e.lineno || "?"); bh.style.color = "var(--vscode-errorForeground, #f14c4c)"; bh.style.opacity = "1"; }
        try { if (typeof vscode !== "undefined") { vscode.postMessage({ type: "webview-error", message: (e.message || "error") + " @" + (e.lineno || "?") }); } } catch(_) {}
    });


    document.getElementById("newSessionBtn").addEventListener("click", () => { setLoading(true, "Starting…"); vscode.postMessage({ type: "new-session" }); });
    document.getElementById("emptyNewSession").addEventListener("click", () => { setLoading(true, "Starting…"); vscode.postMessage({ type: "new-session" }); });
    document.getElementById("bootstrapLink").addEventListener("click", () => { if (bootstrapPath) { vscode.postMessage({ type: "open-file", path: bootstrapPath }); } });
    document.getElementById("archToggle").addEventListener("click", () => { setShowArchived(!showArchived); renderSessions(); });
    sessionFilterBtn.addEventListener("click", (ev) => { ev.stopPropagation(); openSessionsFilterMenu(sessionFilterBtn); });
    if (sessionSearch) { sessionSearch.addEventListener("input", () => { setSessionSearchTerm(sessionSearch.value); renderSessions(); }); }

    // Persisted UI state (send mode + sessions pane width).
    if (saved.sendMode) { sendMode.value = saved.sendMode; }

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
        vscode.postMessage({ type: "list-backends" });
    });


    // Copy the active session's "id title" to the clipboard, with a toast.
    // Wired to BOTH the header copy icon AND clicking the title text itself.
    function copySession(ev) {
        if (ev) { ev.stopPropagation(); }
        const title = (chatTitle.textContent || "").trim();
        const text = [activeSessionId, title].filter(Boolean).join(" ");
        if (!text) { return; }
        let ok = false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text); ok = true;
            }
        } catch (_) { ok = false; }
        if (!ok) {
            // Fallback for webview contexts where navigator.clipboard is blocked:
            // a hidden textarea + execCommand("copy") works on a user gesture.
            try {
                const ta = document.createElement("textarea");
                ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
                document.body.appendChild(ta); ta.select();
                document.execCommand("copy"); document.body.removeChild(ta);
            } catch (_) { /* give up silently */ }
        }
        showToast("Copied session id + title");
    }
    copySessionBtn.addEventListener("click", copySession);
    // Clicking the title text also copies (more discoverable than the icon).
    chatTitle.style.cursor = "pointer";
    chatTitle.title = "Click to copy session id + title";
    chatTitle.addEventListener("click", copySession);

    // Presence / autonomy — quick toggle in the composer, changeable any time
    // (NOT locked while busy); the value is read on every send.
    const PRESENCE = [
        { value: "present", label: "Present", detail: "agent may ask", title: "Normal: the agent can pause to ask you questions." },
        { value: "away", label: "Away", detail: "full autonomy", title: "The agent proceeds without asking; it won't wait for you." },
    ];
    const presenceLbl = presencePicker.querySelector(".lbl");
    const presenceIcon = presencePicker.querySelector(".picon");
    function setPresenceLabel() {
        const away = autonomyValue === "away";
        presenceLbl.textContent = away ? "Away" : "Present";
        presenceIcon.innerHTML = "";
        presenceIcon.appendChild(svgIcon(away ? "robot" : "eye"));
        presencePicker.classList.toggle("away", away);
        presencePicker.title = (away ? "Away — full autonomy" : "Present — agent may ask") + " (change any time)";
    }
    presencePicker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openChoiceMenu(presencePicker, PRESENCE, autonomyValue, (v) => { setAutonomyValue(v); saveState({ autonomy: v }); setPresenceLabel(); });
    });
    // ICONS is imported (no temporal dead zone), so paint the presence icon now.
    setPresenceLabel();

    // ---- tools & configuration menu (sliders) ----
    // Per-session tool gating (native AI backend). available = all tools the
    // backend can expose; enabled = the subset active for this session.
    const TOOL_LABELS = {
        memory_search: "Search memory", memory_get_observations: "Read memory", memory_save: "Save memory",
        web_search: "Web search", fetch_url: "Fetch URL", open_url: "Open URL (browser)",
        shell: "Shell / commands", read_file: "Read file", write_file: "Write file",
        list_dir: "List directory", read_session: "Re-read session history",
    };
    const PERM_DESC = {
        "default": "Ask for permission as needed",
        "acceptEdits": "Auto-accept file edits",
        "bypassPermissions": "Run everything without prompts",
        "plan": "Plan only — no edits/commands",
    };
    configBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ctxMenu.textContent = "";
        const list = document.createElement("div"); list.className = "menuList";
        if (permissionModes.length) {
            const gh = document.createElement("div"); gh.className = "menuGroup"; gh.textContent = "Permission mode"; list.appendChild(gh);
            for (const p of permissionModes) {
                const isActive = p === permissionValue;
                const mi = document.createElement("div"); mi.className = "mi" + (isActive ? " active" : "");
                const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = isActive ? "✓" : "";
                const lbl = document.createElement("span"); lbl.className = "milbl";
                const lblText = document.createElement("span"); lblText.className = "milbl-text";
                lblText.textContent = p + (p === permissionDefault ? " (default)" : "");
                const lblDesc = document.createElement("span"); lblDesc.className = "milbl-desc";
                lblDesc.textContent = PERM_DESC[p] || "";
                lbl.appendChild(lblText); lbl.appendChild(lblDesc);
                mi.appendChild(tick); mi.appendChild(lbl);
                mi.addEventListener("click", () => { setPermissionValue(p); ctxMenu.style.display = "none"; });
                list.appendChild(mi);
            }
            const sep = document.createElement("div"); sep.className = "sep"; list.appendChild(sep);
        }
        // Per-session tools: checkbox list (like VS Code chat's tool picker).
        if (aiToolsAvailable.length) {
            const gh = document.createElement("div"); gh.className = "menuGroup"; gh.textContent = "Active tools"; list.appendChild(gh);
            for (const name of aiToolsAvailable) {
                const on = aiToolsEnabled.includes(name);
                const mi = document.createElement("div"); mi.className = "mi" + (on ? " active" : "");
                const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = on ? "✓" : "";
                const l = document.createElement("span"); l.className = "milbl";
                const lt2 = document.createElement("span"); lt2.className = "milbl-text"; lt2.textContent = TOOL_LABELS[name] || name;
                const ld = document.createElement("span"); ld.className = "milbl-desc"; ld.textContent = name;
                l.appendChild(lt2); l.appendChild(ld);
                mi.appendChild(tick); mi.appendChild(l);
                mi.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (aiToolsEnabled.includes(name)) { setAiToolsEnabled(aiToolsEnabled.filter((n) => n !== name)); }
                    else { setAiToolsEnabled([...aiToolsEnabled, name]); }
                    vscode.postMessage({ type: "set-tools", tools: aiToolsEnabled });
                    tick.textContent = aiToolsEnabled.includes(name) ? "✓" : "";
                    mi.classList.toggle("active", aiToolsEnabled.includes(name));
                });
                list.appendChild(mi);
            }
            const sep2 = document.createElement("div"); sep2.className = "sep"; list.appendChild(sep2);
        }
        // Re-probe rtk availability (gates the token-saving RTK preamble).
        const recheck = document.createElement("div"); recheck.className = "mi";
        const rt = document.createElement("span"); rt.className = "tick";
        const rlbl = document.createElement("span"); rlbl.className = "milbl";
        const rlt = document.createElement("span"); rlt.className = "milbl-text"; rlt.textContent = "Re-check shell tools (rtk)";
        const rld = document.createElement("span"); rld.className = "milbl-desc"; rld.textContent = "probe rtk after installing it";
        rlbl.appendChild(rlt); rlbl.appendChild(rld);
        recheck.appendChild(rt); recheck.appendChild(rlbl);
        recheck.addEventListener("click", () => { vscode.postMessage({ type: "recheck-shell-tools" }); ctxMenu.style.display = "none"; });
        list.appendChild(recheck);

        const open = document.createElement("div"); open.className = "mi";
        const t = document.createElement("span"); t.className = "tick";
        const lbl = document.createElement("span"); lbl.className = "milbl";
        const lt = document.createElement("span"); lt.className = "milbl-text"; lt.textContent = "Open Settings…";
        lbl.appendChild(lt);
        open.appendChild(t); open.appendChild(lbl);
        open.addEventListener("click", () => { vscode.postMessage({ type: "open-settings" }); ctxMenu.style.display = "none"; });
        list.appendChild(open);
        ctxMenu.appendChild(list);
        ctxMenu.style.display = "block";
        const r = configBtn.getBoundingClientRect(); const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
        ctxMenu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";
        ctxMenu.style.top = Math.max(4, r.top - h - 4) + "px";
    });

    // ---- resizable sessions pane ----
    if (saved.paneWidth) { sessionsPane.style.width = saved.paneWidth + "px"; }
    let dragging = false;
    resizer.addEventListener("pointerdown", (e) => {
        dragging = true; resizer.classList.add("dragging");
        resizer.setPointerCapture(e.pointerId); e.preventDefault();
    });
    resizer.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const r = root.getBoundingClientRect();
        let w = sideIsRight() ? (r.right - e.clientX) : (e.clientX - r.left);
        w = Math.max(180, Math.min(520, Math.round(w)));
        sessionsPane.style.width = w + "px";
    });
    const endDrag = () => { if (dragging) { dragging = false; resizer.classList.remove("dragging"); saveState({ paneWidth: parseInt(sessionsPane.style.width, 10) }); } };
    resizer.addEventListener("pointerup", endDrag);
    resizer.addEventListener("pointercancel", endDrag);



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
        addBrowserPage.style.display = "none";   // shown only while a Simple Browser is open
        addBrowserPage.addEventListener("click", () => vscode.postMessage({ type: "attach-browser-page" }));
    }

    // Paste: images become attachments (written to a temp file by the
    // extension); text falls through to the textarea natively.
    // Single listener on the document (paste bubbles up from the textarea);
    // adding it to both the input and the document fired it twice.

    // Drag & drop files onto the composer → attachments (parity with paste).
    // OS files arrive as dataTransfer.files; VS Code Explorer drags as a
    // text/uri-list of file:// URIs. The extension writes/resolves them and
    // posts attachments-picked back, which adds the chips.
    const dragRelevant = (dt) => !!dt && Array.from(dt.types || []).some((t) => t === "Files" || t === "text/uri-list");
    ["dragenter", "dragover"].forEach((evName) => composerEl.addEventListener(evName, (e) => {
        if (!dragRelevant(e.dataTransfer)) { return; }
        e.preventDefault(); e.stopPropagation();
        try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
        composerEl.classList.add("dragover");
    }));
    composerEl.addEventListener("dragleave", (e) => {
        if (!composerEl.contains(e.relatedTarget)) { composerEl.classList.remove("dragover"); }
    });
    composerEl.addEventListener("drop", (e) => {
        if (!e.dataTransfer) { return; }
        e.preventDefault(); e.stopPropagation();
        composerEl.classList.remove("dragover");
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) {
            const payloads = [];
            let pending = files.length;
            const flush = () => { if (--pending === 0 && payloads.length) { vscode.postMessage({ type: "drop-files", files: payloads }); } };
            files.forEach((file) => {
                const reader = new FileReader();
                reader.onload = () => { payloads.push({ name: file.name, mime: file.type, data: String(reader.result).split(",")[1] || "" }); flush(); };
                reader.onerror = () => flush();
                reader.readAsDataURL(file);
            });
            return;
        }
        const uriList = e.dataTransfer.getData("text/uri-list");
        if (uriList) {
            const uris = uriList.split(/\r?\n/).map((u) => u.trim()).filter((u) => u && u.charAt(0) !== "#");
            if (uris.length) { vscode.postMessage({ type: "drop-uris", uris }); return; }
        }
        const plain = (e.dataTransfer.getData("text/plain") || "").trim();
        if (plain && (plain.startsWith("file:") || plain.startsWith("/"))) {
            const uris = plain.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
                .map((s) => (s.startsWith("file:") ? s : "file://" + s));
            vscode.postMessage({ type: "drop-uris", uris });
        }
    });



    setStatus();
    refreshEmpty();   // show the placeholder until a conversation loads
    // Handshake: the extension queues everything until this script is live,
    // so meta/history posted right after construction are never lost.
    vscode.postMessage({ type: "ready" });