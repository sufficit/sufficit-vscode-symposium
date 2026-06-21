/**
 * Chat webview client script — extracted from chatHtml.ts.
 * Runs inside the webview (no extension/Node APIs). Injected into a
 * nonce-guarded <script>. Escapes preserved verbatim from the original literal.
 */
export const chatClientJs = `    window.addEventListener("error", (e) => {
        const bh = document.getElementById("bootHint");
        if (bh) { bh.textContent = "❌ " + (e.message || "erro JS") + " @" + (e.lineno || "?"); bh.style.color = "var(--vscode-errorForeground, #f14c4c)"; bh.style.opacity = "1"; }
        try { if (typeof vscode !== "undefined") { vscode.postMessage({ type: "webview-error", message: (e.message || "error") + " @" + (e.lineno || "?") }); } } catch(_) {}
    });
    const vscode = acquireVsCodeApi();
    const root = document.getElementById("root");
    const log = document.getElementById("log");
    const input = document.getElementById("input");
    const chips = document.getElementById("chips");
    const addContext = document.getElementById("addContext");
    const modelPicker = document.getElementById("modelPicker");
    const reasoningPicker = document.getElementById("reasoningPicker");
    const sendMode = document.getElementById("sendMode");
    const sendBtn = document.getElementById("send");
    const status = document.getElementById("status");
    const sessionsList = document.getElementById("sessionsList");
    const chatTitle = document.getElementById("chatTitle");
    const listToggle = document.getElementById("listToggle");

    let attachments = [];   // [{path, name}]
    let activeFile = null;  // active editor path, offered as removable context
    let activeFileRange = null;  // { start, end } when lines are selected
    let activeFileDismissed = false;
    let activeFilePreview = false;  // VS Code preview tab (italic) → suggestion only
    let activeFilePinned = false;   // user clicked a preview suggestion to attach it
    function activeFileSuffix() { return activeFileRange ? ":" + activeFileRange.start + "-" + activeFileRange.end : ""; }
    let currentBackend = "", currentBackendName = "", agentLabels = null;
    let activeModel = "";
    let activeSessionId = "";
    let busy = false;
    let queued = 0;
    let loading = false;
    let sessions = [];
    let showArchived = false;

    document.getElementById("newSessionBtn").addEventListener("click", () => { setLoading(true, "Starting…"); vscode.postMessage({ type: "new-session" }); });
    document.getElementById("emptyNewSession").addEventListener("click", () => { setLoading(true, "Starting…"); vscode.postMessage({ type: "new-session" }); });
    document.getElementById("archToggle").addEventListener("click", () => { showArchived = !showArchived; renderSessions(); });

    // Persisted UI state (send mode + sessions pane width).
    const saved = (vscode.getState && vscode.getState()) || {};
    function saveState(patch) { vscode.setState && vscode.setState(Object.assign({}, saved, patch)); Object.assign(saved, patch); }
    if (saved.sendMode) { sendMode.value = saved.sendMode; }
    sendMode.addEventListener("change", () => saveState({ sendMode: sendMode.value }));

    // Split send-button: caret opens a small menu to choose Send/Queue/Steer.
    // Each mode has its own icon and its own keyboard shortcut (like the
    // native chat): Enter sends with the selected default mode, while the
    // modifier shortcuts force a specific mode regardless of the default.
    const sendCaret = document.getElementById("sendCaret");
    const sendIcon = document.getElementById("sendIcon");
    const sendGroup = document.getElementById("sendGroup");
    const stopBtn = document.getElementById("stopBtn");
    const isMac = navigator.platform.indexOf("Mac") === 0;
    const MOD = isMac ? "⌘" : "Ctrl";
    const ALT = isMac ? "⌥" : "Alt";
    const MODE_LABELS = { send: "Send", queue: "Queue", steer: "Steer" };
    const MODE_KBD = { send: "Enter", queue: ALT + "+Enter", steer: MOD + "+Enter" };
    const MODE_ICONS = {
        // paper plane
        send: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.2 2.8 3 8 1.2 13.2a.5.5 0 0 0 .7.6l13-5.5a.5.5 0 0 0 0-.9l-13-5.5a.5.5 0 0 0-.7.6Z"/></svg>',
        // clock (wait, then send)
        queue: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 0 11Z"/><path d="M7.25 4h1.5v4.1l2.9 1.7-.75 1.3-3.65-2.15V4Z"/></svg>',
        // lightning bolt (interrupt and send now)
        steer: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.4 1 3 9h3.6l-1.3 6 7.7-9.2H9.2L10.5 1H9.4Z"/></svg>',
    };
    const MODE_DESC = {
        send: "Send now; queued while a turn runs",
        queue: "Always wait for the current turn (FIFO)",
        steer: "Interrupt the running turn and send now",
    };
    const STOP_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';
    function updateSendTitle() {
        // Idle: plain Send (paper plane). While a turn runs, the button reflects
        // what the NEXT message will do — queue (clock) or steer (lightning) —
        // per the selected mode, so the icon previews the action. Clicking sends
        // in that mode; Stop the running turn with Esc (or the caret menu).
        if (busy) {
            const mode = (sendMode.value === "steer") ? "steer" : "queue";
            sendGroup.classList.add("busy");
            sendGroup.classList.toggle("steer", mode === "steer");
            sendIcon.innerHTML = MODE_ICONS[mode];
            sendBtn.title = (mode === "steer")
                ? "Steer: interrupt the running turn and send now (Ctrl/Cmd+Enter) · Esc to stop"
                : "Queue: send after the current turn finishes (Alt+Enter) · Esc to stop";
            sendCaret.style.display = "";
            stopBtn.style.display = "";
            return;
        }
        sendGroup.classList.remove("busy", "steer", "stopping");
        sendIcon.innerHTML = MODE_ICONS.send;
        sendBtn.title = "Send (Enter)";
        sendCaret.style.display = "none";
        stopBtn.style.display = "none";
    }
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
    updateSendTitle();

    // ---- themed dropdowns replacing native <select> ----
    // options: [{ value, label, group?, detail?, title? }]; opts: { search?: bool }
    function openChoiceMenu(anchorEl, options, current, onPick, opts) {
        opts = opts || {};
        ctxMenu.textContent = "";
        const wantSearch = opts.search || options.length >= 9;

        const list = document.createElement("div"); list.className = "menuList";
        const renderRows = (filter) => {
            list.textContent = "";
            const q = (filter || "").toLowerCase();
            let lastGroup = null; let shown = 0;
            for (const o of options) {
                if (q && !(o.label + " " + (o.detail || "")).toLowerCase().includes(q)) continue;
                if (o.group && o.group !== lastGroup) {
                    lastGroup = o.group;
                    const gh = document.createElement("div"); gh.className = "menuGroup"; gh.textContent = o.group;
                    list.appendChild(gh);
                }
                const mi = document.createElement("div"); mi.className = "mi";
                const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = o.value === current ? "✓" : "";
                const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = o.label;
                mi.appendChild(tick); mi.appendChild(lbl);
                if (o.detail) { const d = document.createElement("span"); d.className = "midetail"; d.textContent = o.detail; mi.appendChild(d); }
                if (o.title) mi.title = o.title;
                if (o.actions && o.actions.length) {
                    const acts = document.createElement("span"); acts.className = "miacts";
                    for (const act of o.actions) {
                        const btn = document.createElement("button");
                        btn.className = "miact" + (act.on ? " on" : "");
                        btn.title = act.title; btn.innerHTML = act.icon;
                        btn.addEventListener("click", (e) => { e.stopPropagation(); act.onClick(); });
                        acts.appendChild(btn);
                    }
                    mi.appendChild(acts);
                }
                mi.addEventListener("click", () => onPick(o.value));
                list.appendChild(mi);
                shown++;
            }
            if (!shown) { const e = document.createElement("div"); e.className = "mi"; e.style.opacity = "0.6"; e.textContent = "no matches"; list.appendChild(e); }
        };

        if (wantSearch) {
            const box = document.createElement("input"); box.className = "menuSearch"; box.type = "text"; box.placeholder = "Search…";
            box.addEventListener("input", () => renderRows(box.value));
            box.addEventListener("click", (e) => e.stopPropagation());
            box.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCtx(); });
            ctxMenu.appendChild(box);
            setTimeout(() => box.focus(), 0);
        }
        if (opts.refreshAction) {
            const rb = document.createElement("div"); rb.className = "mi";
            const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = "↻";
            const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = opts.refreshAction.label || "Refresh";
            rb.appendChild(tick); rb.appendChild(lbl);
            if (opts.refreshAction.detail) { const d = document.createElement("span"); d.className = "midetail"; d.textContent = opts.refreshAction.detail; rb.appendChild(d); }
            rb.addEventListener("click", () => { hideCtx(); opts.refreshAction.onClick(); });
            ctxMenu.appendChild(rb);
        }
        renderRows("");
        ctxMenu.appendChild(list);

        // Optional free-form entry row: lets the user type a value not present
        // in the list (used by the model picker when discovery returned none).
        if (opts.manualEntry) {
            const me = opts.manualEntry;
            const wrap = document.createElement("div"); wrap.className = "menuManual";
            const input = document.createElement("input");
            input.className = "menuSearch"; input.type = "text";
            input.placeholder = me.placeholder || me.label || "Type a value…";
            input.addEventListener("click", (e) => e.stopPropagation());
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); const v = input.value; hideCtx(); me.onSubmit(v); }
                else if (e.key === "Escape") { hideCtx(); }
            });
            const hint = document.createElement("div"); hint.className = "menuGroup"; hint.textContent = me.label || "Manual entry";
            wrap.appendChild(hint); wrap.appendChild(input);
            ctxMenu.appendChild(wrap);
            if (!options.length) { setTimeout(() => input.focus(), 0); }
        }

        ctxMenu.style.display = "block";
        const r = anchorEl.getBoundingClientRect();
        const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
        ctxMenu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";
        ctxMenu.style.top = Math.max(4, r.top - h - 4) + "px";
    }
    let modelValue = "", modelList = [], reasoningValue = "default", reasoningList = [];
    let reasoningDefault = "", modelDefault = "", modelLabels = {}, pinnedModels = [];
    const SVG_PIN = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11 1a1 1 0 0 0-1 1v1H6V2a1 1 0 0 0-2 0v1H3a1 1 0 0 0-1 1v2c0 2.21 1.79 4 4 4v3H5a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2h-1V9.95c2.15-.32 4-2.12 4-3.95V4a1 1 0 0 0-1-1h-1V2a1 1 0 0 0-1-1Z"/></svg>';
    const SVG_STAR = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.9 3.9 4.1.6-3 2.9.7 4.1-3.7-2-3.7 2 .7-4.1-3-2.9 4.1-.6Z"/></svg>';
    function modelLabel(id) { return (id && modelLabels[id]) || id; }
    const modelLbl = modelPicker.querySelector(".lbl");
    const reasoningLbl = reasoningPicker.querySelector(".lbl");
    // "default" means: don't override — the backend uses its own default. When
    // a default is configured in settings, show it in parens so it's not blind.
    function defLabel(configured) { return configured && configured !== "default" ? "default (" + configured + ")" : "default"; }
    function setModelLabel() { modelLbl.textContent = modelValue && modelValue !== "default" ? modelLabel(modelValue) : defLabel(modelDefault); }
    function setReasoningLabel() { reasoningLbl.textContent = reasoningValue && reasoningValue !== "default" ? "effort: " + reasoningValue : defLabel(reasoningDefault); }
    function buildModelMenuOpts() {
        const pinned = pinnedModels || [];
        const rest = modelList.filter((m) => !pinned.includes(m));
        const makeActions = (m) => m === "default" ? [] : [
            { icon: SVG_PIN, title: pinned.includes(m) ? "Desafixar modelo" : "Fixar no topo", on: pinned.includes(m),
              onClick: () => { vscode.postMessage({ type: "pin-model", model: m }); hideCtx(); } },
            { icon: SVG_STAR, title: modelDefault === m ? "Remover como padrão" : "Definir como padrão para novas sessões", on: modelDefault === m,
              onClick: () => { vscode.postMessage({ type: "set-model-default", model: modelDefault === m ? "" : m }); hideCtx(); } },
        ];
        const opts = [];
        if (pinned.length) {
            for (const m of pinned) {
                opts.push({ value: m, label: modelLabel(m), group: "Fixados", actions: makeActions(m) });
            }
        }
        for (const m of rest) {
            opts.push({ value: m, label: m === "default" ? defLabel(modelDefault) : modelLabel(m), group: pinned.length ? "Todos" : undefined, actions: makeActions(m) });
        }
        return opts;
    }
    modelPicker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (modelPicker.disabled) return;
        // Always offer a manual entry so the user is never stuck when remote
        // discovery (GET /models) returned nothing — e.g. not logged in yet, or
        // the gateway answered 401. Picking it prompts for a free-form id.
        openChoiceMenu(modelPicker, buildModelMenuOpts(), modelValue, (v) => { modelValue = v; setModelLabel(); }, {
            refreshAction: { label: "Atualizar modelos", detail: "Refaz GET /models", onClick: () => vscode.postMessage({ type: "refresh-models" }) },
            manualEntry: { label: "Digitar modelo…", placeholder: "ex.: gpt-4o, claude-3-5-sonnet", onSubmit: (v) => { if (v && v.trim()) { modelValue = v.trim(); setModelLabel(); } } },
        });
    });
    reasoningPicker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (reasoningPicker.disabled || !reasoningList.length) return;
        openChoiceMenu(reasoningPicker, reasoningList.map((r) => ({ value: r, label: r === "default" ? defLabel(reasoningDefault) : r })), reasoningValue, (v) => { reasoningValue = v; setReasoningLabel(); });
    });

    // Switch agent — hand this dialogue off to another backend in place. The
    // list of candidates is requested live (it depends on the current backend),
    // then shown as a menu anchored to the header button.
    const switchAgentBtn = document.getElementById("switchAgentBtn");
    let pendingSwitchAnchor = null;
    switchAgentBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pendingSwitchAnchor = switchAgentBtn;
        vscode.postMessage({ type: "list-backends" });
    });

    // Presence / autonomy — quick toggle in the composer, changeable any time
    // (NOT locked while busy); the value is read on every send.
    let autonomyValue = (saved && saved.autonomy) || "present";
    const PRESENCE = [
        { value: "present", label: "Present", detail: "agent may ask", title: "Normal: the agent can pause to ask you questions." },
        { value: "away", label: "Away", detail: "full autonomy", title: "The agent proceeds without asking; it won't wait for you." },
    ];
    const presencePicker = document.getElementById("presencePicker");
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
        openChoiceMenu(presencePicker, PRESENCE, autonomyValue, (v) => { autonomyValue = v; saveState({ autonomy: v }); setPresenceLabel(); });
    });
    // Initial paint deferred: setPresenceLabel() calls svgIcon(), which reads
    // the ICONS const declared further down. Calling it here would hit ICONS's
    // temporal dead zone and throw, aborting the whole composer script (blank
    // chat). Invoked once ICONS is initialized instead.

    // ---- tools & configuration menu (sliders) ----
    const configBtn = document.getElementById("configBtn");
    let permissionModes = [], permissionValue = "default", permissionDefault = "default";
    // Per-session tool gating (native AI backend). available = all tools the
    // backend can expose; enabled = the subset active for this session.
    let aiToolsAvailable = [], aiToolsEnabled = [];
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
                mi.addEventListener("click", () => { permissionValue = p; ctxMenu.style.display = "none"; });
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
                    if (aiToolsEnabled.includes(name)) { aiToolsEnabled = aiToolsEnabled.filter((n) => n !== name); }
                    else { aiToolsEnabled = [...aiToolsEnabled, name]; }
                    vscode.postMessage({ type: "set-tools", tools: aiToolsEnabled });
                    tick.textContent = aiToolsEnabled.includes(name) ? "✓" : "";
                    mi.classList.toggle("active", aiToolsEnabled.includes(name));
                });
                list.appendChild(mi);
            }
            const sep2 = document.createElement("div"); sep2.className = "sep"; list.appendChild(sep2);
        }
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
    const sessionsPane = document.getElementById("sessionsPane");
    const resizer = document.getElementById("resizer");
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

    let sideMode = "auto"; // "auto" | "left" | "right", from config

    // The sessions pane sits on the OUTER edge: when the view is docked on the
    // right of the window, sessions go right; docked left, sessions go left.
    // With no API for dock side, infer it from the webview's screen position.
    function sideIsRight() {
        if (sideMode === "left") return false;
        if (sideMode === "right") return true;
        try {
            const center = (window.screenX || 0) + window.innerWidth / 2;
            return center > (window.screen.width / 2);
        } catch (e) {
            return false;
        }
    }

    // Responsive: a wide surface shows the sessions pane beside the chat,
    // a narrow one hides it behind the toggle — same feel as the built-in
    // chat sessions viewer.
    const NARROW = 640;
    function layout() {
        root.classList.toggle("narrow", document.body.clientWidth < NARROW);
        root.classList.toggle("side-right", sideIsRight());
    }
    new ResizeObserver(layout).observe(document.body);
    layout();
    listToggle.addEventListener("click", () => root.classList.toggle("listOpen"));

    // Auto-scroll only when the user is already near the bottom, so reading
    // scrollback isn't yanked away mid-stream.
    function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
    // Marks the last PROGRAMMATIC scroll so the context-menu auto-close can tell
    // it apart from a user scroll (new messages auto-scroll the log, which must
    // not close an open menu like the send-mode picker).
    let lastAutoScroll = 0;
    function autoScroll(stick) { if (stick) { lastAutoScroll = Date.now(); log.scrollTop = log.scrollHeight; } }
    // Force-scroll to the very bottom, after layout settles (history/images can
    // change height a frame later, so do it now + on the next frame).
    function scrollToBottom() {
        lastAutoScroll = Date.now();
        log.scrollTop = log.scrollHeight;
        requestAnimationFrame(() => { lastAutoScroll = Date.now(); log.scrollTop = log.scrollHeight; updateScrollBtn(); });
    }
    // Floating "scroll to bottom" button: visible only when scrolled up.
    let scrollBtn = null;
    function updateScrollBtn() {
        if (!scrollBtn) { return; }
        scrollBtn.classList.toggle("show", !nearBottom() && log.childElementCount > 0);
    }
    log.addEventListener("scroll", updateScrollBtn);
    scrollBtn = document.getElementById("scrollBottom");
    if (scrollBtn) { scrollBtn.addEventListener("click", scrollToBottom); }
    // Show the empty-state placeholder when the log has no messages yet.
    function refreshEmpty() { root.classList.toggle("empty", log.childElementCount === 0); }

    // Error block with a Retry action (re-sends the last user message).
    function renderError(message) {
        const stick = nearBottom();
        endToolGroup(); endStream();
        const el = document.createElement("div"); el.className = "msg plain error";
        const txt = document.createElement("div"); txt.textContent = "✖ " + message; el.appendChild(txt);
        // Retry is just "edit & resend the last user message": it loads that
        // message back into the composer (so you can change the model, text, or
        // mode) and resending rewinds the history to that point.
        const lastUser = lastUserRow();
        if (lastUser) {
            const bar = document.createElement("div"); bar.className = "errActions";
            const b = document.createElement("button"); b.className = "retryBtn";
            b.appendChild(svgIcon("history")); b.appendChild(document.createTextNode(" Edit & retry"));
            b.addEventListener("click", () => beginEdit(lastUser.idx, lastUser.text));
            bar.appendChild(b); el.appendChild(bar);
        }
        log.appendChild(el); refreshEmpty(); autoScroll(stick);
    }
    function append(cls, text) {
        const stick = nearBottom();
        endToolGroup(); endStream();
        const el = document.createElement("div");
        el.className = "msg plain " + cls;
        el.textContent = text;
        log.appendChild(el);
        refreshEmpty();
        autoScroll(stick);
        return el;
    }
    function branchBanner(title, detail) {
        const stick = nearBottom();
        endToolGroup(); endStream();
        const el = document.createElement("div");
        el.className = "branchBanner";
        const icon = document.createElement("span"); icon.className = "branchIcon"; icon.appendChild(svgIcon("history"));
        const body = document.createElement("div"); body.className = "branchBody";
        const ttl = document.createElement("div"); ttl.className = "branchTitle"; ttl.textContent = title || "Branched conversation";
        body.appendChild(ttl);
        if (detail) {
            const sub = document.createElement("div"); sub.className = "branchDetail"; sub.textContent = detail;
            body.appendChild(sub);
        }
        el.appendChild(icon); el.appendChild(body);
        log.appendChild(el);
        refreshEmpty();
        autoScroll(stick);
        return el;
    }

    // Consecutive tool calls are gathered into one timeline group (a vertical
    // rail) with a summary header, so a turn's work reads as a single activity
    // block instead of a loose list of rows.
    let curToolGroup = null;
    function endToolGroup() { curToolGroup = null; }
    function toolGroupBody() {
        if (curToolGroup) { return curToolGroup._body; }
        const stick = nearBottom();
        const g = document.createElement("div"); g.className = "msg toolgroup";
        const head = document.createElement("div"); head.className = "tghead";
        const chev = svgIcon("chevron"); chev.classList.add("tgchev");
        const sum = document.createElement("span"); sum.className = "tgsum";
        head.appendChild(chev); head.appendChild(sum);
        const body = document.createElement("div"); body.className = "tgbody";
        head.addEventListener("click", () => g.classList.toggle("collapsed"));
        g.appendChild(head); g.appendChild(body);
        g._body = body; g._sum = sum; g._n = 0; g._add = 0; g._del = 0;
        log.appendChild(g);
        refreshEmpty();
        curToolGroup = g;
        autoScroll(stick);
        return body;
    }
    function bumpToolGroup(added, removed) {
        const g = curToolGroup; if (!g) { return; }
        g._n += 1; g._add += added || 0; g._del += removed || 0;
        let s = g._n + (g._n === 1 ? " action" : " actions");
        if (g._add) { s += "  +" + g._add; }
        if (g._del) { s += " -" + g._del; }
        g._sum.textContent = s;
    }

    // A chat message with a small role label (user/assistant); assistant text
    // is rendered as markdown.
    const BACKEND_NAMES = { claude: "Claude", codex: "Codex", copilot: "Copilot", openai: "Sufficit AI" };
    let conversationRows = [];
    // Track last rendered assistant context to show role label only on change
    let lastMsgBackend = "", lastMsgModel = "";
    function message(role, text, ts, model) {
        const stick = nearBottom();
        endToolGroup();
        const wrap = document.createElement("div");
        wrap.className = "msg " + role;
        wrap.dataset.role = role;
        wrap.dataset.msgIndex = String(conversationRows.length);
        conversationRows.push({ role, text: text || "" });
        const label = document.createElement("div");
        label.className = "role " + role;
        if (role === "assistant") {
            const effectiveModel = model || activeModel || "";
            const sameContext = currentBackend === lastMsgBackend && effectiveModel === lastMsgModel && lastMsgBackend !== "";
            if (sameContext) { label.classList.add("rolePassive"); }
            lastMsgBackend = currentBackend;
            lastMsgModel = effectiveModel;
            const av = document.createElement("span"); av.className = "avatar"; av.appendChild(svgIcon("robot"));
            const name = document.createElement("span"); name.textContent = currentBackendName || BACKEND_NAMES[currentBackend] || "Agent";
            label.appendChild(av); label.appendChild(name);
        } else {
            // Reset after user message so the next assistant reply always shows its label
            if (role === "user") { lastMsgBackend = ""; lastMsgModel = ""; }
            const name = document.createElement("span"); name.textContent = "You";
            label.appendChild(name);
        }
        // Hover-only timestamp next to the role (only when we have a real time).
        if (ts) {
            const d = new Date(ts), now = new Date();
            const sameDay = d.toDateString() === now.toDateString();
            const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            // Other days include the date so it's never ambiguous.
            const text = sameDay ? time : d.toLocaleDateString([], { day: "2-digit", month: "short" }) + " " + time;
            const t = document.createElement("span"); t.className = "msgTime";
            t.textContent = text;
            t.title = d.toLocaleString();
            label.appendChild(t);
        }
        wrap.appendChild(label);
        const body = document.createElement("div");
        if (role === "assistant") { body.className = "md"; renderMarkdown(body, text); }
        else { body.className = "ubody"; body.textContent = text; }
        wrap.appendChild(body);
        const tools = document.createElement("div"); tools.className = "msgTools";
        if (role === "user") {
            // Edit & resend from here: load this message back into the composer;
            // re-sending rewinds the conversation to this point (Esc cancels).
            const edit = document.createElement("button"); edit.className = "msgCopy"; edit.title = "Edit & resend from here";
            edit.appendChild(svgIcon("edit"));
            edit.addEventListener("click", () => {
                const idx = Number(wrap.dataset.msgIndex || "-1");
                if (idx >= 0) { beginEdit(idx, wrap._raw != null ? wrap._raw : text); }
            });
            tools.appendChild(edit);
        }
        if (role === "assistant") {
            const cp = document.createElement("button"); cp.className = "msgCopy"; cp.title = "Copy this reply";
            cp.appendChild(svgIcon("copy"));
            cp.addEventListener("click", () => {
                navigator.clipboard && navigator.clipboard.writeText(wrap._raw != null ? wrap._raw : text);
                cp.classList.add("done"); setTimeout(() => cp.classList.remove("done"), 1000);
            });
            tools.appendChild(cp);
        }
        wrap.appendChild(tools);
        wrap._raw = text;
        log.appendChild(wrap);
        refreshEmpty();
        autoScroll(stick);
        return wrap;
    }

    // Coalesce streaming assistant deltas into ONE message (the OpenAI adapter
    // emits token-by-token; without this each token became its own bubble).
    let streamMsg = null, streamBody = null, streamText = "";
    function streamDelta(text) {
        const stick = nearBottom();
        endThinkingStream(); // close any open thinking block before first text token
        if (!streamMsg) {
            streamMsg = message("assistant", "", Date.now());
            streamBody = streamMsg.querySelector(".md");
            streamText = "";
        }
        streamText += text;
        streamMsg._raw = streamText;
        const idx = Number(streamMsg.dataset.msgIndex || "-1");
        if (idx >= 0 && conversationRows[idx]) { conversationRows[idx].text = streamText; }
        if (streamBody) { streamBody.textContent = ""; renderMarkdown(streamBody, streamText); }
        autoScroll(stick);
    }
    function endStream() { streamMsg = null; streamBody = null; streamText = ""; endThinkingStream(); }

    // Streaming thinking blocks (extended reasoning).
    let streamThink = null, streamThinkBody = null, streamThinkLen = null, streamThinkText = "";
    const THINK_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5A5.5 5.5 0 1 0 13.5 7c0-.67-.12-1.32-.35-1.92A2 2 0 0 1 11 6.5a2 2 0 0 1-2-2c0-.31.07-.6.19-.86A5.5 5.5 0 0 0 8 1.5ZM1 7a7 7 0 1 1 7.96 6.94 1.5 1.5 0 1 1-1.33-2.67A7 7 0 0 1 1 7Z"/></svg>';
    function renderThinkBlock(text) {
        const stick = nearBottom();
        const wrap = document.createElement("div"); wrap.className = "msg thinkWrap";
        const det = document.createElement("details"); det.className = "thinkBlock";
        const sum = document.createElement("summary"); sum.className = "thinkSum";
        const ic = document.createElement("span"); ic.innerHTML = THINK_ICON;
        const lbl = document.createElement("span"); lbl.textContent = "Pensando…";
        const chev = document.createElement("span"); chev.className = "thinkChev"; chev.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 3l5 5-5 5"/></svg>';
        const len = document.createElement("span"); len.className = "thinkLen"; len.textContent = text.length + " chars";
        sum.append(ic, lbl, chev, len);
        const body = document.createElement("div"); body.className = "thinkBody"; body.textContent = text;
        det.append(sum, body); wrap.append(det);
        log.appendChild(wrap); refreshEmpty(); autoScroll(stick);
        return { wrap, body, len };
    }
    function streamThinkingDelta(text) {
        const stick = nearBottom();
        if (!streamThink) {
            const { wrap, body, len } = renderThinkBlock("");
            streamThink = wrap; streamThinkBody = body; streamThinkLen = len; streamThinkText = "";
        }
        streamThinkText += text;
        streamThinkBody.textContent = streamThinkText;
        streamThinkLen.textContent = streamThinkText.length + " chars";
        autoScroll(stick);
    }
    function endThinkingStream() { streamThink = null; streamThinkBody = null; streamThinkLen = null; streamThinkText = ""; }

    // ---- minimal, safe markdown → DOM (no innerHTML of untrusted text) ----
    function renderMarkdown(container, src) {
        const lines = String(src).split("\\n");
        let i = 0; let list = null;
        const flushList = () => { list = null; };
        while (i < lines.length) {
            const line = lines[i];
            const codexTag = codexTagStart(line);
            if (codexTag) {
                flushList();
                i++;
                const body = [];
                const close = "</" + codexTag + ">";
                while (i < lines.length && lines[i].trim() !== close) { body.push(lines[i]); i++; }
                if (i < lines.length && lines[i].trim() === close) i++;
                container.appendChild(tagBlock(codexTag, body.join("\\n")));
                continue;
            }
            const fence = line.match(/^\`\`\`(\\w*)\\s*$/);
            if (fence) {
                flushList();
                const lang = fence[1] || "";
                const buf = [];
                i++;
                while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
                i++; // skip closing fence
                // A todo/plan fence is surfaced in the pinned Plan panel — don't
                // also render it raw in the message (avoids duplicated grey blocks).
                const lg = lang.toLowerCase();
                if (lg !== "todo" && lg !== "plan" && lg !== "tasks") {
                    container.appendChild(codeBlock(lang, buf.join("\\n")));
                }
                continue;
            }
            const h = line.match(/^(#{1,6})\\s+(.*)$/);
            if (h) { flushList(); const el = document.createElement("h" + h[1].length); inline(el, h[2]); container.appendChild(el); i++; continue; }
            if (/^\\s*([-*_])(\\s*\\1){2,}\\s*$/.test(line)) { flushList(); container.appendChild(document.createElement("hr")); i++; continue; }
            const bq = line.match(/^\\s*>\\s?(.*)$/);
            if (bq) {
                flushList();
                const quote = document.createElement("blockquote");
                while (i < lines.length) {
                    const q = lines[i].match(/^\\s*>\\s?(.*)$/);
                    if (!q) break;
                    const p = document.createElement("p"); inline(p, q[1]); quote.appendChild(p); i++;
                }
                container.appendChild(quote); continue;
            }
            // GFM table: a "| h | h |" header followed by a "| --- | --- |" rule.
            if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
                flushList();
                const head = tableCells(line);
                i += 2;
                const rows = [];
                while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) { rows.push(tableCells(lines[i])); i++; }
                container.appendChild(tableEl(head, rows));
                continue;
            }
            const li = line.match(/^\\s*[-*]\\s+(.*)$/);
            const oli = line.match(/^\\s*\\d+\\.\\s+(.*)$/);
            if (li || oli) {
                const ordered = !!oli;
                if (!list || list.dataset.ord !== String(ordered)) { list = document.createElement(ordered ? "ol" : "ul"); list.dataset.ord = String(ordered); container.appendChild(list); }
                const item = document.createElement("li"); inline(item, (li || oli)[1]); list.appendChild(item); i++; continue;
            }
            if (!line.trim()) { flushList(); i++; continue; }
            // paragraph: gather consecutive non-empty, non-special lines
            flushList();
            const para = [line]; i++;
            while (i < lines.length && lines[i].trim() && !/^(#{1,6}\\s|\\s*[-*]\\s|\\s*\\d+\\.\\s|\\s*>\\s|\`\`\`)/.test(lines[i])) { para.push(lines[i]); i++; }
            const p = document.createElement("p"); inline(p, para.join(" ")); container.appendChild(p);
        }
    }
    // ---- GFM tables (no regex with backslashes — template-safe) ----
    function tableCells(line) {
        let s = line.trim();
        if (s.charAt(0) === "|") { s = s.slice(1); }
        if (s.charAt(s.length - 1) === "|") { s = s.slice(0, -1); }
        return s.split("|").map((c) => c.trim());
    }
    function isTableSep(line) {
        if (line.indexOf("|") < 0 && line.indexOf("-") < 0) { return false; }
        const cells = tableCells(line);
        if (!cells.length) { return false; }
        return cells.every((c) => {
            const t = c.split(" ").join("");
            if (!t || t.indexOf("-") < 0) { return false; }
            for (const ch of t) { if (ch !== "-" && ch !== ":") { return false; } }
            return true;
        });
    }
    function tableEl(head, rows) {
        const t = document.createElement("table"); t.className = "mdtable";
        const thead = document.createElement("thead"); const htr = document.createElement("tr");
        for (const c of head) { const th = document.createElement("th"); inline(th, c); htr.appendChild(th); }
        thead.appendChild(htr); t.appendChild(thead);
        const tb = document.createElement("tbody");
        for (const r of rows) {
            const tr = document.createElement("tr");
            for (let k = 0; k < head.length; k++) { const td = document.createElement("td"); inline(td, r[k] || ""); tr.appendChild(td); }
            tb.appendChild(tr);
        }
        t.appendChild(tb); return t;
    }

    function codeBlock(lang, code) {
        const block = document.createElement("div"); block.className = "codeblock";
        const head = document.createElement("div"); head.className = "cbhead";
        const tag = document.createElement("span"); tag.textContent = lang || "code";
        const copy = document.createElement("button"); copy.className = "cbcopy"; copy.textContent = "Copy";
        copy.addEventListener("click", () => {
            navigator.clipboard && navigator.clipboard.writeText(code);
            copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200);
        });
        head.appendChild(tag); head.appendChild(copy);
        const pre = document.createElement("pre"); const c = document.createElement("code"); c.textContent = code; pre.appendChild(c);
        block.appendChild(head); block.appendChild(pre);
        return block;
    }

    function tagBlock(tag, body) {
        const wrap = document.createElement("details");
        wrap.className = "tagblock";
        const sum = document.createElement("summary");
        const title = document.createElement("span");
        title.className = "tagtitle";
        title.textContent = tag.replace(/_/g, " ");
        const badge = document.createElement("span");
        badge.className = "tagbadge";
        badge.textContent = "codex context";
        sum.appendChild(title); sum.appendChild(badge);
        const pre = document.createElement("pre");
        pre.textContent = body.trim();
        wrap.appendChild(sum); wrap.appendChild(pre);
        return wrap;
    }

    function codexTagStart(line) {
        const t = line.trim();
        const m = t.match(/^<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>\s*$/);
        if (!m) return null;
        const tag = m[1];
        // Only structural wrapper tags get special rendering. Keep HTML-ish
        // inline tags in prose untouched (e.g. <b>, <code>, <c>, <bool>).
        if (tag.indexOf("_") >= 0 || /^(environment|context|instructions|user|developer|system|collaboration|workspace|task|approval|sandbox|model|reasoning)$/i.test(tag)) return tag;
        return null;
    }

    // inline: **bold**, *italic*, \`code\`, [text](url) — builds text nodes safely
    function inline(parent, text) {
        const re = /(\`[^\`]+\`|\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|\\[[^\\]]+\\]\\([^)]+\\))/g;
        let last = 0; let m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
            const tok = m[0];
            if (tok.startsWith("\`")) { const e = document.createElement("code"); e.className = "inline"; e.textContent = tok.slice(1, -1); parent.appendChild(e); }
            else if (tok.startsWith("**")) { const e = document.createElement("strong"); e.textContent = tok.slice(2, -2); parent.appendChild(e); }
            else if (tok.startsWith("*")) { const e = document.createElement("em"); e.textContent = tok.slice(1, -1); parent.appendChild(e); }
            else { const mm = tok.match(/^\\[([^\\]]+)\\]\\(([^)]+)\\)$/); const a = document.createElement("a"); a.textContent = mm[1]; a.href = mm[2]; a.title = mm[2]; parent.appendChild(a); }
            last = re.lastIndex;
        }
        if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
    }

    function setStatus() {
        const q = queued > 0 ? " · " + queued + " queued" : "";
        status.textContent = busy ? ("thinking..." + q) : (activeModel ? "model: " + modelLabel(activeModel) : "");
        // Model/reasoning stay changeable at all times (even while a turn runs):
        // a change applies to the next/queued message. Only disabled when there
        // are no options to pick.
        modelPicker.disabled = !modelList.length;
        reasoningPicker.disabled = !reasoningList.length;
        updateSendTitle();   // mode caret/icon depends on busy state
        syncProgress();
    }

    const progress = document.getElementById("progress");
    const composerEl = document.getElementById("composer");
    // Busy/loading shows as a subtle sweep around the composer border (native-
    // chat style), not a top bar that reads as global.
    function syncProgress() {
        const on = loading || busy;
        progress.classList.remove("on");          // retire the top bar
        if (composerEl) { composerEl.classList.toggle("working", on); }
    }
    // Full loading state shown while a session is being opened (empty log).
    function setLoading(on, text) {
        loading = on;
        if (text) { document.getElementById("loadingText").textContent = text; }
        root.classList.toggle("loading", on);
        syncProgress();
    }

    // SVG icon paths (codicon-style, 16x16 viewBox), built as real SVG nodes.
    const ICONS = {
        terminal: "M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-11Zm2.3 2.2 2.5 2.3-2.5 2.3.7.7 3.2-3-3.2-3-.7.7ZM8 10h4v1H8v-1Z",
        rename: "M12.1 1.6a1.4 1.4 0 0 1 2 2L5 12.7l-2.8.8.8-2.8 9.1-9.1Zm-1 1.4L3.6 10.4l-.4 1.4 1.4-.4 7.5-7.4-1-1Z",
        eye: "M8 3C4.5 3 1.7 5.3 1 8c.7 2.7 3.5 5 7 5s6.3-2.3 7-5c-.7-2.7-3.5-5-7-5Zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5A1.5 1.5 0 1 0 8 6.5a1.5 1.5 0 0 0 0 3Z",
        archive: "M2 3h12v3H2V3Zm1 4h10v6H3V7Zm3 2v1h4V9H6Z",
        unarchive: "M8 2.5 3 6h2v6h6V6h2L8 2.5ZM7 8h2v3H7V8Z",
        trash: "M6 1h4l.5 1H14v1H2V2h3.5L6 1Zm-2.5 3h9l-.7 10H4.2L3.5 4Zm2.5 2v6h1V6H6Zm3 0v6h1V6H9Z",
        send: "M1.2 2.8 3 8 1.2 13.2a.5.5 0 0 0 .7.6l13-5.5a.5.5 0 0 0 0-.9l-13-5.5a.5.5 0 0 0-.7.6Z",
        chat: "M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H6l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5v-6Z",
        file: "M4 1h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Zm5 1v3h3L9 2Z",
        robot: "M7.5 1.5h1V3H11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5V1.5ZM6 6.5A1 1 0 1 0 6 8.5 1 1 0 0 0 6 6.5Zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM1 6h1v4H1V6Zm13 0h1v4h-1V6Z",
        copy: "M5 2h6a1 1 0 0 1 1 1v8h-1V3H5V2ZM3 4h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 1v8h6V5H3Z",
        history: "M8 2a6 6 0 1 0 4.24 1.76l-.7.7A5 5 0 1 1 8 3a4.98 4.98 0 0 1 3.54 1.46L9.5 6.5H14V2l-1.76 1.76A5.96 5.96 0 0 0 8 2Zm-.5 3h1v3.2l2.2 1.3-.5.86L7.5 8.75V5Z",
        plus: "M8 1.5a.5.5 0 0 1 .5.5V7.5h5.5a.5.5 0 0 1 0 1H8.5V14a.5.5 0 0 1-1 0V8.5H2a.5.5 0 0 1 0-1h5.5V2a.5.5 0 0 1 .5-.5Z",
        chevron: "M4 6l4 4 4-4H4Z",
        refresh: "M13.6 2.7v3.2h-3.2l1.2-1.2A4 4 0 1 0 12 8h1.3A5.3 5.3 0 1 1 12.5 4l1.1-1.3Z",
        edit: "M12.1 1.6a1.4 1.4 0 0 1 2 2L5 12.7l-2.8.8.8-2.8 9.1-9.1Zm-1 1.4L3.6 10.4l-.4 1.4 1.4-.4 7.5-7.4-1-1Z",
        search: "M6.5 1a5.5 5.5 0 0 1 4.3 8.9l3.1 3.2-.7.7-3.2-3.1A5.5 5.5 0 1 1 6.5 1Zm0 1a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z",
        globe: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM6.1 5.5h3.8a12 12 0 0 1 0 3H6.1a12 12 0 0 1 0-3ZM8 2.5c.6 0 1.4 1.3 1.8 3.5H6.2C6.6 3.8 7.4 2.5 8 2.5Zm0 11c-.6 0-1.4-1.3-1.8-3.5h3.6c-.4 2.2-1.2 3.5-1.8 3.5Zm3.2-1.3a10 10 0 0 0 .8-2.7h2a5.5 5.5 0 0 1-2.8 2.7Zm.8-3.7a14 14 0 0 0 0-3h2.1A5.5 5.5 0 0 1 13.5 8c0 .5-.1 1-.2 1.5H12Zm.9-4.5H11a10 10 0 0 0-.8-2.7A5.5 5.5 0 0 1 12.9 6ZM3.1 6h2a14 14 0 0 0 0 3h-2A5.5 5.5 0 0 1 2.5 8c0-.7.1-1.4.6-2Zm.2 4.5H5a10 10 0 0 0 .8 2.7 5.5 5.5 0 0 1-2.5-2.7Z",
        list: "M2 3h2v2H2V3Zm4 .5h8v1H6v-1ZM2 7h2v2H2V7Zm4 .5h8v1H6v-1ZM2 11h2v2H2v-2Zm4 .5h8v1H6v-1Z",
        tool: "M11.5 1.5a3.5 3.5 0 0 0-3.4 4.4L1.7 12.3l2 2 6.4-6.4a3.5 3.5 0 0 0 4.4-4.4l-1.9 1.9-1.5-.4-.4-1.5 1.9-1.9a3.5 3.5 0 0 0-1.6-.6Z",
        check: "M6.2 11.3 2.7 7.8l1-1 2.5 2.5L12.3 3.3l1 1-7.1 7Z",
        x: "M5 4 4 5l3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3-3-3Z",
        up: "M8 2.5 3 7.5h3v6h4v-6h3L8 2.5Z",
        down: "M8 13.5 13 8.5h-3v-6H6v6H3L8 13.5Z",
        pin: "M9.5 1.5 8 3l3.5 3.5L13 5l-3.5-3.5ZM7.3 3.8 2.8 8.3l1.4 1.4-3 3.8 3.8-3 1.4 1.4 4.5-4.5L7.3 3.8Z",
        more: "M4 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
        diff: "M4 2h5l3 3v3h-1V6H8V3H4v9h3v1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm6 1.5V5h1.5L10 3.5ZM11 9h1v2h2v1h-2v2h-1v-2H9v-1h2V9Z",
        circleEmpty: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.3A4.7 4.7 0 1 1 8 12.7 4.7 4.7 0 0 1 8 3.3Z",
        circleHalf: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.3A4.7 4.7 0 1 1 8 12.7V3.3Z",
        code: "M5.9 4.3 2.2 8l3.7 3.7.8-.8L4 8l2.7-2.9-.8-.8Zm4.2 0-.8.8L12 8l-2.7 2.9.8.8L13.8 8l-3.7-3.7Z",
        braces: "M6 2c-1.3 0-1.8.7-1.8 1.9v1.4c0 .6-.3.9-1 .9v1.6c.7 0 1 .3 1 .9v1.4c0 1.2.5 1.9 1.8 1.9v-1.2c-.5 0-.7-.2-.7-.8V8.7c0-.6-.3-1-.8-1.2.5-.2.8-.6.8-1.2V4.9c0-.5.2-.8.7-.8V2Zm4 0v1.2c.5 0 .7.3.7.8v1.4c0 .6.3 1 .8 1.2-.5.2-.8.6-.8 1.2v1.5c0 .6-.2.8-.7.8v1.2c1.3 0 1.8-.7 1.8-1.9V9.6c0-.6.3-.9 1-.9V7.1c-.7 0-1-.3-1-.9V4.8C11.8 2.7 11.3 2 10 2Z",
        mdfile: "M2.5 4h11v8h-11V4Zm1.2 6V6h1.1l1.2 1.5L7.2 6h1.1v4H7.2V7.9L6 9.3 4.8 7.9V10H3.7Zm6.4 0V6h1.1v2.6h1.4V10h-2.5Z",
        image: "M2 3h12v10H2V3Zm1 1v5.6l3-3 2.2 2.2 2.8-2.8L13 8V4H3Zm2.2 1.2a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z",
        "arrow-swap": "M4.5 2.5 1 6l3.5 3.5V7H10V5H4.5V2.5Zm7 4L15 10l-3.5 3.5V11H6V9h5.5V6.5Z",
    };
    // ICONS is now initialized — safe to paint the presence picker's icon.
    setPresenceLabel();
    // Per-extension icon + a language-ish tint (webviews can't read VS Code's
    // file-icon theme, so this approximates it by file type).
    const FILE_ICONS = {
        ts: { i: "code", c: "#3178c6" }, tsx: { i: "code", c: "#3178c6" },
        js: { i: "code", c: "#e8c020" }, jsx: { i: "code", c: "#e8c020" }, mjs: { i: "code", c: "#e8c020" }, cjs: { i: "code", c: "#e8c020" },
        json: { i: "braces", c: "#cbcb41" },
        md: { i: "mdfile", c: "#519aba" }, markdown: { i: "mdfile", c: "#519aba" },
        css: { i: "code", c: "#519aba" }, scss: { i: "code", c: "#c6538c" }, less: { i: "code", c: "#519aba" },
        html: { i: "code", c: "#e37933" }, vue: { i: "code", c: "#41b883" }, svelte: { i: "code", c: "#ff3e00" },
        py: { i: "code", c: "#3572A5" }, rs: { i: "code", c: "#dea584" }, go: { i: "code", c: "#00ADD8" },
        java: { i: "code", c: "#b07219" }, c: { i: "code", c: "#555555" }, cpp: { i: "code", c: "#f34b7d" }, cs: { i: "code", c: "#178600" },
        sh: { i: "code", c: "#89e051" }, yml: { i: "braces", c: "#cb171e" }, yaml: { i: "braces", c: "#cb171e" }, toml: { i: "braces", c: "#9c4221" },
        png: { i: "image", c: "#a074c4" }, jpg: { i: "image", c: "#a074c4" }, jpeg: { i: "image", c: "#a074c4" },
        gif: { i: "image", c: "#a074c4" }, svg: { i: "image", c: "#ffb13b" }, webp: { i: "image", c: "#a074c4" },
    };
    function fileIcon(name) {
        const ext = String(name).split(".").pop().toLowerCase();
        return FILE_ICONS[ext] || { i: "file", c: "" };
    }
    function svgIcon(name) {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("fill", "currentColor");
        // Default size: an inline <svg> with only a viewBox (no width/height)
        // falls back to the replaced-element default of 300x150 — which paints
        // huge grey boxes wherever a CSS rule doesn't size the icon. Set a sane
        // intrinsic size; explicit CSS (e.g. .avatar svg) still overrides it.
        svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
        const p = document.createElementNS(ns, "path"); p.setAttribute("d", ICONS[name] || "");
        svg.appendChild(p);
        return svg;
    }

    // Map a backend tool name to a native-chat icon + verb.
    const TOOL_META = {
        Read: { icon: "file", verb: "Read" },
        Write: { icon: "file", verb: "Wrote" },
        Edit: { icon: "edit", verb: "Edited" },
        MultiEdit: { icon: "edit", verb: "Edited" },
        NotebookEdit: { icon: "edit", verb: "Edited" },
        Bash: { icon: "terminal", verb: "Ran" },
        BashOutput: { icon: "terminal", verb: "Output" },
        exec: { icon: "terminal", verb: "Ran" },
        shell: { icon: "terminal", verb: "Ran" },
        read_file: { icon: "file", verb: "Read" },
        write_file: { icon: "file", verb: "Wrote" },
        list_dir: { icon: "file", verb: "Listed" },
        memory_search: { icon: "search", verb: "Memory" },
        memory_get_observations: { icon: "search", verb: "Memory" },
        memory_save: { icon: "file", verb: "Saved memory" },
        web_search: { icon: "globe", verb: "Searched web" },
        fetch_url: { icon: "globe", verb: "Fetched" },
        open_url: { icon: "globe", verb: "Opened" },
        read_session: { icon: "search", verb: "Read session" },
        Glob: { icon: "search", verb: "Searched" },
        Grep: { icon: "search", verb: "Searched" },
        LS: { icon: "file", verb: "Listed" },
        Task: { icon: "robot", verb: "Task" },
        WebFetch: { icon: "globe", verb: "Fetched" },
        WebSearch: { icon: "globe", verb: "Searched web" },
        TodoWrite: { icon: "list", verb: "Updated plan" },
    };
    // Live tool rows awaiting their result, keyed by tool id.
    const toolRows = {};
    const TAB = String.fromCharCode(9);
    function allDigits(s) { return s.length > 0 && [...s].every((ch) => ch >= "0" && ch <= "9"); }
    // Tool output from Read comes as "  <n>\t<code>"; split the line number into
    // a non-selectable gutter so copying the result never includes the numbers.
    function toolSection(label, text) {
        const sec = document.createElement("div"); sec.className = "toolsec";
        const lab = document.createElement("div"); lab.className = "tlabel"; lab.textContent = label;
        const lines = String(text).split("\\n");
        const numbered = lines.filter((l) => { const i = l.indexOf(TAB); return i > 0 && allDigits(l.slice(0, i).trim()); });
        if (numbered.length > 1 && numbered.length >= lines.length * 0.5) {
            const pre = document.createElement("pre"); pre.className = "numbered";
            for (const line of lines) {
                const i = line.indexOf(TAB);
                const isNum = i > 0 && allDigits(line.slice(0, i).trim());
                const row = document.createElement("div"); row.className = "ln";
                const g = document.createElement("span"); g.className = "lnum"; g.textContent = isNum ? line.slice(0, i).trim() : "";
                const c = document.createElement("span"); c.className = "lcode"; c.textContent = isNum ? line.slice(i + 1) : line;
                row.appendChild(g); row.appendChild(c); pre.appendChild(row);
            }
            sec.appendChild(lab); sec.appendChild(pre);
        } else {
            const pre = document.createElement("pre"); pre.textContent = text;
            sec.appendChild(lab); sec.appendChild(pre);
        }
        return sec;
    }
    // A red/green line diff for edit hunks (trims common leading/trailing lines).
    function diffSection(hunks) {
        const sec = document.createElement("div"); sec.className = "toolsec";
        const lab = document.createElement("div"); lab.className = "tlabel"; lab.textContent = "Diff";
        const pre = document.createElement("pre"); pre.className = "diff";
        const addLine = (cls, sign, text) => {
            const d = document.createElement("div"); d.className = "dl " + cls;
            const g = document.createElement("span"); g.className = "dsign"; g.textContent = sign;
            const c = document.createElement("span"); c.className = "dtext"; c.textContent = text;
            d.appendChild(g); d.appendChild(c); pre.appendChild(d);
        };
        hunks.forEach((h, idx) => {
            if (idx > 0) { addLine("dctx", "", "⋯"); }
            let oldL = (h.old || "").split("\\n");
            let newL = (h.new || "").split("\\n");
            // Trim shared prefix/suffix so only the actual change shows.
            let p = 0; while (p < oldL.length && p < newL.length && oldL[p] === newL[p]) { p++; }
            let s = 0; while (s < oldL.length - p && s < newL.length - p && oldL[oldL.length - 1 - s] === newL[newL.length - 1 - s]) { s++; }
            const ctxPre = oldL.slice(Math.max(0, p - 1), p);
            for (const l of ctxPre) { addLine("dctx", " ", l); }
            for (const l of oldL.slice(p, oldL.length - s)) { addLine("ddel", "-", l); }
            for (const l of newL.slice(p, newL.length - s)) { addLine("dadd", "+", l); }
            const ctxPost = oldL.slice(oldL.length - s, oldL.length - s + 1);
            for (const l of ctxPost) { addLine("dctx", " ", l); }
        });
        sec.appendChild(lab); sec.appendChild(pre);
        return sec;
    }
    // Shorten a file path for display: keep the start and the tail (filename +
    // a few parent segments), dropping the middle with an ellipsis so the most
    // meaningful parts stay visible. The full path is kept in the tooltip.
    function middleEllipsisPath(text, max) {
        const s = String(text);
        if (s.length <= max) { return s; }
        const ell = "…";
        // Bias toward the end (filename) while still showing the root prefix.
        const tail = Math.max(Math.ceil((max - ell.length) * 0.62), 1);
        const head = Math.max(max - ell.length - tail, 1);
        return s.slice(0, head) + ell + s.slice(s.length - tail);
    }
    // Expandable tool panel (icon + verb + target, click to reveal input/result).
    function renderTool(name, detail, opts) {
        opts = opts || {};
        // A plan/todo update renders as the evolving checklist panel, not a row.
        if (opts.todos) { renderTodos(opts.todos); return null; }
        // Skip an empty tool row: some backends (responses-API function_call)
        // can emit a tool-start with no name/detail/input/result yet, which would
        // otherwise paint a blank grey placeholder box in the log.
        const hasName = typeof name === "string" && name.trim();
        const hasContent = (detail && String(detail).trim()) || opts.input || opts.result || (opts.diff && opts.diff.length) || opts.path;
        if (!hasName && !hasContent) { return null; }
        const stick = nearBottom();
        const meta = TOOL_META[name] || { icon: "tool", verb: name };
        const wrap = document.createElement("div"); wrap.className = "msg toolwrap";
        const head = document.createElement("div"); head.className = "toolrow";
        const ic = document.createElement("span"); ic.className = "tIcon";
        // File tools get the per-type icon + tint; others keep the action icon.
        if (opts.path) {
            const fi = fileIcon(String(opts.path).split("/").pop());
            ic.appendChild(svgIcon(fi.i));
            if (fi.c) { ic.style.color = fi.c; ic.style.opacity = "1"; }
        } else {
            ic.appendChild(svgIcon(meta.icon));
        }
        const verb = document.createElement("span"); verb.className = "tVerb"; verb.textContent = meta.verb;
        head.appendChild(ic); head.appendChild(verb);
        if (detail) {
            const tg = document.createElement("span"); tg.className = "tTarget";
            // For file paths, shorten the display by keeping the start and end
            // and dropping the middle with an ellipsis; full path stays in the
            // tooltip. Non-path details are shown verbatim.
            tg.textContent = opts.path ? middleEllipsisPath(detail, 48) : detail;
            // A file-referencing tool: make the target a link (click = diff,
            // right-click = open file / open diff menu).
            if (opts.path) {
                tg.classList.add("tLink"); tg.title = opts.path + " — click for diff, right-click for more";
                tg.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "file-diff", path: opts.path }); });
                tg.addEventListener("contextmenu", (e) => showFileMenu(e, opts.path));
            }
            head.appendChild(tg);
        } else {
            const sp = document.createElement("span"); sp.className = "tSpacer"; head.appendChild(sp);
        }
        if (opts.added != null || opts.removed != null) {
            const d = document.createElement("span"); d.className = "tDiff";
            if (opts.added) { const a = document.createElement("span"); a.className = "tAdd"; a.textContent = "+" + opts.added; d.appendChild(a); }
            if (opts.removed) { const r = document.createElement("span"); r.className = "tDel"; r.textContent = "-" + opts.removed; d.appendChild(r); }
            if (d.childNodes.length) { head.appendChild(d); }
        }
        const body = document.createElement("div"); body.className = "toolbody";
        if (opts.diff && opts.diff.length) { body.appendChild(diffSection(opts.diff)); }
        else if (opts.input) { body.appendChild(toolSection("Input", opts.input)); }
        let resultSec = null;
        let resultText = "";
        const showResult = (text) => {
            if (!text) return;
            resultText += String(text);
            const shown = resultText.length > 30000 ? resultText.slice(resultText.length - 30000) : resultText;
            if (!resultSec) { resultSec = toolSection("Result", shown); body.appendChild(resultSec); }
            else { resultSec.querySelector("pre").textContent = shown; }
        };
        if (opts.result) { showResult(opts.result); }
        const expandable = !!(opts.input || opts.result || opts.toolId);
        if (expandable) {
            const chev = document.createElement("span"); chev.className = "tChev"; chev.appendChild(svgIcon("chevron"));
            head.appendChild(chev);
            head.classList.add("expandable");
            head.addEventListener("click", () => wrap.classList.toggle("open"));
        }
        wrap.appendChild(head); wrap.appendChild(body);
        toolGroupBody().appendChild(wrap);
        bumpToolGroup(opts.added, opts.removed);
        autoScroll(stick);
        if (opts.toolId) { toolRows[opts.toolId] = { showResult }; }
        return wrap;
    }
    function fillToolResult(toolId, result) {
        const rec = toolId && toolRows[toolId];
        if (rec) { rec.showResult(result); }
    }

    // ---- plan / todo (pinned above the edited-files set, per session) ----
    const planEl = document.getElementById("plan");
    const planBySession = {};   // sessionId -> todos[]
    function todoMark(status) {
        if (status === "completed") return svgIcon("check");
        if (status === "in_progress") return svgIcon("circleHalf");
        return svgIcon("circleEmpty");
    }
    function clearTodos(which) {
        const todos = planBySession[wsKey] || [];
        if (which === "done") {
            planBySession[wsKey] = todos.filter((t) => t.status !== "completed");
        } else {
            planBySession[wsKey] = [];
        }
        renderPlan();
    }
    // A TodoWrite carries the full current list; just store it for this session.
    function renderTodos(todos) {
        planBySession[wsKey] = todos || [];
        renderPlan();
    }
    function renderPlan() {
        const todos = planBySession[wsKey] || [];
        planEl.textContent = "";
        if (!todos.length) { planEl.classList.remove("has"); return; }
        planEl.classList.add("has");
        const done = todos.filter((t) => t.status === "completed").length;
        // Header summary mirrors Copilot Chat: show the task in progress (or the
        // next pending one, or a generic label once everything is done).
        const current = todos.find((t) => t.status === "in_progress")
            || todos.find((t) => t.status === "pending");
        const summary = current ? current.content : "Todos";

        // Bordered card wrapper (matches the chat-todo-list-widget look).
        const card = document.createElement("div"); card.className = "plcard";
        const head = document.createElement("div"); head.className = "plhead";
        const chev = svgIcon("chevron"); chev.classList.add("plchev");
        head.appendChild(svgIcon("list"));
        const ttl = document.createElement("span"); ttl.className = "pltitle";
        ttl.textContent = summary; ttl.title = summary;
        const cnt = document.createElement("span"); cnt.className = "plcount"; cnt.textContent = done + "/" + todos.length;
        head.appendChild(ttl); head.appendChild(cnt); head.appendChild(chev);
        head.addEventListener("click", () => planEl.classList.toggle("collapsed"));
        const actions = document.createElement("div"); actions.className = "plactions";
        const mkAction = (icon, label, title, cls, disabled, fn) => {
            const b = document.createElement("button"); b.className = "plaction " + (cls || ""); b.title = title; b.disabled = !!disabled;
            b.appendChild(svgIcon(icon)); b.appendChild(document.createTextNode(label));
            b.addEventListener("click", (e) => { e.stopPropagation(); if (!b.disabled) { fn(); } });
            return b;
        };
        actions.appendChild(mkAction("check", "Limpar concluídas", "Limpar tarefas concluídas", "", done === 0, () => clearTodos("done")));
        actions.appendChild(mkAction("trash", "Limpar todas", "Limpar todas as tarefas", "danger", false, () => clearTodos("all")));
        const list = document.createElement("div"); list.className = "pllist";
        for (const t of todos) {
            const item = document.createElement("div");
            item.className = "todoitem" + (t.status === "completed" ? " done" : t.status === "in_progress" ? " active" : "");
            const ord = document.createElement("span"); ord.className = "torder"; ord.textContent = String(t.order || (todos.indexOf(t) + 1)) + ".";
            const mk = document.createElement("span"); mk.className = "tmark" + (t.status === "pending" ? " pending" : "");
            mk.appendChild(todoMark(t.status));
            const c = document.createElement("span"); c.className = "tcontent"; c.textContent = t.content;
            item.appendChild(ord); item.appendChild(mk); item.appendChild(c);
            list.appendChild(item);
        }
        card.appendChild(head); card.appendChild(actions); card.appendChild(list);
        planEl.appendChild(card);
    }

    // ---- Tasks panel (Sufficit-memory task list, local mirror) ----
    const tasksEl = document.getElementById("tasks");
    function relWhen(iso) {
        const t = Date.parse(iso); if (!t) { return ""; }
        const s = Math.max(0, (Date.now() - t) / 1000);
        if (s < 90) { return "agora"; }
        if (s < 3600) { return Math.round(s / 60) + "m"; }
        if (s < 86400) { return Math.round(s / 3600) + "h"; }
        if (s < 2592000) { return Math.round(s / 86400) + "d"; }
        return new Date(t).toLocaleDateString([], { day: "2-digit", month: "short" });
    }
    let tasksCollapsed = false;   // persisted across re-renders
    function renderTasks(items, project) {
        tasksEl.textContent = "";
        // No tasks for this session → don't show the panel at all.
        if (!items || !items.length) { tasksEl.classList.remove("has"); return; }
        const card = document.createElement("div"); card.className = "tkcard";
        const head = document.createElement("div"); head.className = "tkhead";
        head.appendChild(svgIcon("list"));
        const ttl = document.createElement("span"); ttl.className = "tktitle";
        ttl.textContent = "Tasks";
        ttl.title = "Tarefas da memória Sufficit desta sessão (espelho em .vscode/symposium.tasks.json)" + (project ? " — sessão " + project : "");
        const cnt = document.createElement("span"); cnt.className = "tkcount"; cnt.textContent = String(items.length);
        const refresh = document.createElement("button"); refresh.className = "tkbtn"; refresh.title = "Atualizar da memória";
        refresh.appendChild(svgIcon("refresh"));
        refresh.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "refresh-tasks" }); });
        const chev = svgIcon("chevron"); chev.classList.add("tkchev");
        head.appendChild(ttl); head.appendChild(cnt); head.appendChild(refresh); head.appendChild(chev);
        head.addEventListener("click", () => {
            tasksCollapsed = !tasksCollapsed;
            tasksEl.classList.toggle("collapsed", tasksCollapsed);
        });
        card.appendChild(head);
        const list = document.createElement("div"); list.className = "tklist";
        for (const it of items) {
            const row = document.createElement("div"); row.className = "tkitem";
            const isAnchor = String(it.type || "").indexOf("anchor") >= 0;
            const badge = document.createElement("span");
            badge.className = "tkbadge" + (isAnchor ? " anchor" : "");
            badge.textContent = isAnchor ? "anchor" : "check";
            const txt = document.createElement("span"); txt.className = "tktext";
            txt.textContent = it.title || it.summary || "(sem título)";
            txt.title = (it.title ? it.title + "\\n\\n" : "") + (it.summary || "");
            const when = document.createElement("span"); when.className = "tkwhen"; when.textContent = relWhen(it.ts);
            row.appendChild(badge); row.appendChild(txt); row.appendChild(when);
            list.appendChild(row);
        }
        card.appendChild(list);
        tasksEl.appendChild(card);
        tasksEl.classList.add("has");
        tasksEl.classList.toggle("collapsed", tasksCollapsed);
    }

    // ---- queued messages (editable until dispatched) ----
    const queuedEl = document.getElementById("queued");
    function renderQueued(items) {
        queued = items.length;   // keep status text in sync
        queuedEl.textContent = "";
        if (!items.length) { queuedEl.classList.remove("has"); setStatus(); return; }
        queuedEl.classList.add("has");
        const head = document.createElement("div"); head.className = "qhead"; head.textContent = "Queued";
        queuedEl.appendChild(head);
        for (const it of items) {
            const row = document.createElement("div"); row.className = "qitem";
            const main = document.createElement("div"); main.className = "qmain";
            const txt = document.createElement("div"); txt.className = "qtext"; txt.textContent = it.text;
            txt.title = "Click to edit"; txt.addEventListener("click", () => vscode.postMessage({ type: "queue-edit", id: it.id }));
            main.appendChild(txt);
            if (it.attachments && it.attachments.length) {
                const atts = document.createElement("div"); atts.className = "qatts";
                for (const p of it.attachments) {
                    const chip = document.createElement("span"); chip.className = "qatt"; chip.title = p;
                    const ic = svgIcon("file"); ic.classList.add("qattIcon"); chip.appendChild(ic);
                    chip.appendChild(document.createTextNode(String(p).split("/").pop() || p));
                    atts.appendChild(chip);
                }
                main.appendChild(atts);
            }
            const acts = document.createElement("span"); acts.className = "qacts";
            const mkBtn = (icon, title, type) => {
                const b = document.createElement("button"); b.className = "qbtn"; b.title = title;
                b.appendChild(svgIcon(icon));
                b.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type, id: it.id }); });
                return b;
            };
            acts.appendChild(mkBtn("edit", "Edit", "queue-edit"));
            acts.appendChild(mkBtn("up", "Send next", "queue-promote"));
            acts.appendChild(mkBtn("x", "Remove", "queue-remove"));
            row.appendChild(main); row.appendChild(acts);
            queuedEl.appendChild(row);
        }
        setStatus();
    }

    // ---- changed-files working set (above the composer) ----
    // The edited-files list is OWNED BY THE CONTROLLER (extension side) and
    // pushed via {type:"changed-files"}, so it survives view switches and keeps
    // approvals resolved. The plan, below, is still session-keyed in the webview.
    const changedFiles = document.getElementById("changedFiles");
    const NEW_KEY = "__new__";          // placeholder until a session id arrives
    let wsKey = NEW_KEY;
    let changedItems = [];              // [{ path, added, removed }] from controller
    // Switch the active PLAN to a session id (changed-files comes from controller).
    function startWorkingSet(sessionId) {
        wsKey = sessionId || NEW_KEY;
        delete planBySession[wsKey];
        renderPlan();
    }
    function bindWorkingSet(sessionId) {
        if (!sessionId || wsKey === sessionId) { return; }
        if (wsKey === NEW_KEY && planBySession[NEW_KEY]) {
            planBySession[sessionId] = planBySession[NEW_KEY]; delete planBySession[NEW_KEY];
        }
        wsKey = sessionId;
        renderPlan();
    }
    function cfActionBtn(icon, title, cls, onClick) {
        const b = document.createElement("button"); b.className = "cfbtn " + (cls || ""); b.title = title;
        b.appendChild(svgIcon(icon));
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return b;
    }
    function cfLabelBtn(icon, label, title, cls, onClick) {
        const b = document.createElement("button"); b.className = "cfbtn labeled " + (cls || ""); b.title = title;
        b.appendChild(svgIcon(icon));
        const t = document.createElement("span"); t.textContent = label; b.appendChild(t);
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return b;
    }
    function renderChangedFiles() {
        const items = changedItems;
        changedFiles.textContent = "";
        if (!items.length) { changedFiles.classList.remove("has"); return; }
        changedFiles.classList.add("has");
        const head = document.createElement("div"); head.className = "cfhead";
        const chev = svgIcon("chevron"); chev.classList.add("cfchev");
        const ttl = document.createElement("span"); ttl.className = "cftitle"; ttl.textContent = "Edited files (" + items.length + ")";
        head.appendChild(chev); head.appendChild(ttl);
        const acts = document.createElement("span"); acts.className = "cfheadActs";
        acts.appendChild(cfLabelBtn("check", "Approve all", "Accept all (git add)", "ok", () => vscode.postMessage({ type: "file-approve-all" })));
        acts.appendChild(cfLabelBtn("x", "Reject all", "Revert all to pre-edit state", "no", () => vscode.postMessage({ type: "file-reject-all" })));
        head.appendChild(acts);
        head.addEventListener("click", () => changedFiles.classList.toggle("collapsed"));
        const list = document.createElement("div"); list.className = "cflist";
        for (const c of items) {
            const p = c.path;
            const parts = p.split("/").filter(Boolean);
            const name = parts[parts.length - 1] || p;
            const dir = parts.slice(-3, -1).join("/");
            const it = document.createElement("div"); it.className = "cfitem"; it.title = p + " — click to diff";
            const fi = fileIcon(name);
            const ic = document.createElement("span"); ic.className = "cficon"; ic.appendChild(svgIcon(fi.i));
            if (fi.c) { ic.style.color = fi.c; ic.style.opacity = "1"; }
            const nm = document.createElement("span"); nm.className = "cfname";
            nm.textContent = name;
            if (dir) { const dd = document.createElement("span"); dd.className = "cfdir"; dd.textContent = "  " + dir; nm.appendChild(dd); }
            const df = document.createElement("span"); df.className = "cfdiff";
            if (c.added) { const a = document.createElement("span"); a.className = "tAdd"; a.textContent = "+" + c.added; df.appendChild(a); }
            if (c.removed) { const r = document.createElement("span"); r.className = "tDel"; r.textContent = "-" + c.removed; df.appendChild(r); }
            it.appendChild(ic); it.appendChild(nm); it.appendChild(df);
            const fa = document.createElement("span"); fa.className = "cfacts";
            fa.appendChild(cfActionBtn("check", "Approve (git add)", "ok", () => vscode.postMessage({ type: "file-approve", path: p })));
            fa.appendChild(cfActionBtn("x", "Reject (revert)", "no", () => vscode.postMessage({ type: "file-reject", path: p })));
            it.appendChild(fa);
            it.addEventListener("click", () => vscode.postMessage({ type: "file-diff", path: p }));
            list.appendChild(it);
        }
        changedFiles.appendChild(head); changedFiles.appendChild(list);
    }
    function resetWorkingState() {
        // clear arrives before meta; the controller re-sends changed-files on
        // attach, so just hide the panels here.
        endToolGroup(); endStream();
        changedItems = [];
        changedFiles.textContent = "";
        changedFiles.classList.remove("has");
        planEl.textContent = "";
        planEl.classList.remove("has");
        queuedEl.textContent = "";
        queuedEl.classList.remove("has");
    }

    // Per-session actions, shown as hover icons on the right and in the
    // right-click menu. Each posts a session-action the extension handles.
    // Terminal + watch-live are CLI-only features; API backends have no executable.
    const CLI_BACKENDS = { claude: 1, codex: 1, copilot: 1 };
    function actionsFor(s) {
        const cli = !!CLI_BACKENDS[s.backend];
        const list = [];
        if (cli) {
            list.push({ id: "open", icon: "terminal", label: "Resume in terminal" });
        }
        list.push({ id: "rename", icon: "rename", label: "Rename" });
        if (cli) {
            list.push({ id: "watch", icon: "eye", label: "Watch live (read-only)" });
        }
        list.push({ id: "switchAgent", icon: "arrow-swap", label: "Switch model →" });
        if (s.pinned) {
            list.push({ id: "pinUp", icon: "up", label: "Move pin up" });
            list.push({ id: "pinDown", icon: "down", label: "Move pin down" });
            list.push({ id: "unpin", icon: "pin", label: "Unpin" });
        } else {
            list.push({ id: "pin", icon: "pin", label: "Pin to top" });
        }
        list.push(s.archived
            ? { id: "unarchive", icon: "unarchive", label: "Unarchive" }
            : { id: "archive", icon: "archive", label: "Archive" });
        list.push({ id: "delete", icon: "trash", label: "Delete permanently", danger: true });
        return list;
    }

    // Remembers the session + anchor while the backend submenu is requested,
    // so the "backends" reply (async) can be shown as a follow-up menu.
    let pendingSessionSwitch = null;
    function runAction(s, action) {
        if (action === "switchAgent") {
            // Don't close the menu position context; request the candidate
            // backends, then reopen as a submenu anchored at the same spot.
            const rect = ctxMenu.getBoundingClientRect();
            pendingSessionSwitch = { session: s, x: rect.left, y: rect.top };
            hideCtx();
            vscode.postMessage({ type: "session-list-backends", sessionId: s.sessionId, backend: s.backend });
            return;
        }
        hideCtx();
        vscode.postMessage({ type: "session-action", action, sessionId: s.sessionId, backend: s.backend });
    }

    // Relative time like the native viewer ("agora", "5 min atrás", "1 dia atrás").
    function relTime(iso) {
        if (!iso) return "";
        const d = (Date.now() - new Date(iso).getTime()) / 1000;
        if (d < 60) return "agora";
        if (d < 3600) return Math.floor(d / 60) + " min atrás";
        if (d < 86400) return Math.floor(d / 3600) + "h atrás";
        if (d < 172800) return "ontem";
        if (d < 604800) return Math.floor(d / 86400) + " dias atrás";
        if (d < 2592000) return Math.floor(d / 604800) + " sem atrás";
        return Math.floor(d / 2592000) + " meses atrás";
    }
    // Recency bucket header label.
    function bucket(iso) {
        if (!iso) return "Sem data";
        const d = (Date.now() - new Date(iso).getTime()) / 1000;
        if (d < 86400) return "Hoje";
        if (d < 172800) return "Ontem";
        if (d < 604800) return "Esta semana";
        if (d < 2592000) return "Este mês";
        return "Mais antigo";
    }

    function groupHeader(label, count) {
        const gh = document.createElement("div"); gh.className = "groupHeader";
        const gl = document.createElement("span"); gl.textContent = label;
        const gc = document.createElement("span"); gc.className = "gcount"; gc.textContent = String(count);
        gh.appendChild(gl); gh.appendChild(gc);
        return gh;
    }
    function renderAccount(profile) {
        const el = document.getElementById("accountFooter");
        if (!el) { return; }
        el.textContent = "";
        if (profile && (profile.name || profile.email)) {
            if (profile.picture) {
                const img = document.createElement("img");
                img.setAttribute("src", profile.picture); img.alt = "";
                el.appendChild(img);
            } else {
                const ic = document.createElement("div");
                ic.className = "acc-ico";
                ic.textContent = (profile.name || profile.email || "?").trim().charAt(0).toUpperCase();
                el.appendChild(ic);
            }
            const txt = document.createElement("div");
            txt.className = "acc-text";
            const nm = document.createElement("div");
            nm.className = "acc-name"; nm.textContent = profile.name || profile.email;
            txt.appendChild(nm);
            if (profile.name && profile.email) {
                const sub = document.createElement("div");
                sub.className = "acc-sub"; sub.textContent = profile.email;
                txt.appendChild(sub);
            }
            el.appendChild(txt);
            const out = document.createElement("span");
            out.className = "acc-out"; out.title = "Sair"; out.textContent = "⎋";
            out.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: "account-logout" }); };
            el.appendChild(out);
            el.onclick = null;
        } else {
            const ic = document.createElement("div");
            ic.className = "acc-ico"; ic.textContent = "↪";
            el.appendChild(ic);
            const txt = document.createElement("div");
            txt.className = "acc-text";
            const nm = document.createElement("div");
            nm.className = "acc-name"; nm.textContent = "Entrar na Sufficit";
            txt.appendChild(nm);
            el.appendChild(txt);
            el.onclick = () => vscode.postMessage({ type: "account-login" });
        }
    }

    function renderSessions() {
        sessionsList.textContent = "";
        const visible = sessions.filter((s) => !s.archived || showArchived);
        const pinned = visible.filter((s) => s.pinned).sort((a, b) => (a.pinIndex || 0) - (b.pinIndex || 0));
        const rest = visible.filter((s) => !s.pinned);
        if (pinned.length) {
            sessionsList.appendChild(groupHeader("Pinned", pinned.length));
            for (const s of pinned) { sessionsList.appendChild(renderSessionItem(s)); }
        }
        let lastBucket = null;
        for (const s of rest) {
            const bk = bucket(s.updatedAt);
            if (bk !== lastBucket) {
                lastBucket = bk;
                const count = rest.filter((x) => bucket(x.updatedAt) === bk).length;
                sessionsList.appendChild(groupHeader(bk, count));
            }
            sessionsList.appendChild(renderSessionItem(s));
        }
    }
    let dragPinId = null;
    // Drop the dragged pinned session before the target, persist the new order.
    function dropPinnedOn(targetId) {
        if (!dragPinId || dragPinId === targetId) { return; }
        const order = sessions.filter((s) => s.pinned).sort((a, b) => (a.pinIndex || 0) - (b.pinIndex || 0)).map((s) => s.sessionId);
        const from = order.indexOf(dragPinId), to = order.indexOf(targetId);
        if (from < 0 || to < 0) { return; }
        order.splice(from, 1);
        order.splice(order.indexOf(targetId), 0, dragPinId);
        // Optimistic reorder so it feels instant, then persist.
        const idx = {}; order.forEach((id, i) => idx[id] = i);
        for (const s of sessions) { if (s.pinned) { s.pinIndex = idx[s.sessionId]; } }
        renderSessions();
        vscode.postMessage({ type: "reorder-pinned", ids: order });
    }
    function renderSessionItem(s) {
            const el = document.createElement("div");
            el.className = "sessionItem" + (s.sessionId === activeSessionId ? " active" : "") + (s.archived ? " archived" : "") + (s.pinned ? " pinned" : "") + (s.deleting ? " deleting" : "");
            el.tabIndex = 0;
            el.setAttribute("role", "option");
            el.setAttribute("aria-selected", s.sessionId === activeSessionId ? "true" : "false");
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); body.click(); }
                else if (e.key === "ArrowDown") { e.preventDefault(); const next = el.nextElementSibling; if (next && next.classList.contains("sessionItem")) { next.focus(); } else { const after = el.parentElement.querySelectorAll(".sessionItem"); const idx = Array.from(after).indexOf(el); if (idx + 1 < after.length) { after[idx + 1].focus(); } } }
                else if (e.key === "ArrowUp") { e.preventDefault(); const prev = el.previousElementSibling; if (prev && prev.classList.contains("sessionItem")) { prev.focus(); } else { const all = el.parentElement.querySelectorAll(".sessionItem"); const idx = Array.from(all).indexOf(el); if (idx > 0) { all[idx - 1].focus(); } } }
            });
            // Pinned items reorder by drag-and-drop (the up/down menu still works).
            if (s.pinned) {
                el.draggable = true;
                el.addEventListener("dragstart", (e) => { dragPinId = s.sessionId; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
                el.addEventListener("dragend", () => { dragPinId = null; el.classList.remove("dragging"); document.querySelectorAll(".sessionItem.dropTarget").forEach((x) => x.classList.remove("dropTarget")); });
                el.addEventListener("dragover", (e) => { if (dragPinId && dragPinId !== s.sessionId) { e.preventDefault(); el.classList.add("dropTarget"); } });
                el.addEventListener("dragleave", () => el.classList.remove("dropTarget"));
                el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("dropTarget"); dropPinnedOn(s.sessionId); });
            }

            // Live status indicator: spinner = working, green dot = idle/live.
            const statusDot = document.createElement("div");
            statusDot.className = "statusDot";
            if (s.deleting) {
                const sp = document.createElement("span"); sp.className = "spinner"; sp.title = "Deleting…"; statusDot.appendChild(sp);
            } else if (s.status === "working") {
                const w = document.createElement("span"); w.className = "work"; w.title = "Agent working…"; statusDot.appendChild(w);
            } else if (s.status === "idle") {
                const d = document.createElement("span"); d.className = "idle"; d.title = "Running session (idle)"; statusDot.appendChild(d);
            } else {
                const ic = svgIcon("chat"); ic.classList.add("stored"); ic.setAttribute("aria-hidden", "true"); statusDot.appendChild(ic);
            }

            const body = document.createElement("div");
            body.className = "body";
            const ttl = document.createElement("div");
            ttl.className = "ttl";
            if (s.pinned) { const pn = svgIcon("pin"); pn.classList.add("ttlIcon"); ttl.appendChild(pn); }
            if (s.archived) { const ar = svgIcon("archive"); ar.classList.add("ttlIcon"); ttl.appendChild(ar); }
            ttl.appendChild(document.createTextNode(s.title));
            ttl.title = s.title + "\\n" + s.sessionId;
            const sub = document.createElement("span");
            sub.className = "sub";
            if (s.deleting) {
                sub.textContent = "deleting…";
            } else {
                const statusText = s.status === "working" ? "working… · " : (s.status === "idle" ? "live · " : "");
                sub.textContent = statusText + s.backend + (s.updatedAt ? " · " + relTime(s.updatedAt) : "");
            }
            sub.title = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
            body.appendChild(ttl);
            body.appendChild(sub);
            // While a delete scrub is in flight the row is inert (no open / no menu).
            if (!s.deleting) {
                body.addEventListener("click", () => {
                    root.classList.remove("listOpen");
                    activeSessionId = s.sessionId; renderSessions();
                    setLoading(true, "Loading session…");
                    vscode.postMessage({ type: "open-session", sessionId: s.sessionId, backend: s.backend });
                });
            }

            // One "more" button opens the same menu as right-click.
            const acts = document.createElement("div");
            acts.className = "acts";
            if (!s.deleting) {
                const more = document.createElement("button");
                more.appendChild(svgIcon("more")); more.title = "Actions"; more.setAttribute("aria-label", "Actions");
                more.addEventListener("click", (ev) => { ev.stopPropagation(); showCtx(ev, s); });
                acts.appendChild(more);
            }

            el.appendChild(statusDot);
            el.appendChild(body);
            el.appendChild(acts);
            if (!s.deleting) {
                el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); showCtx(ev, s); });
            }
            return el;
    }

    const ctxMenu = document.getElementById("ctxMenu");
    function hideCtx() { ctxMenu.style.display = "none"; }
    function showCtx(ev, s) {
        ctxMenu.textContent = "";
        for (const a of actionsFor(s)) {
            if (a.danger) {
                const sep = document.createElement("div"); sep.className = "sep"; ctxMenu.appendChild(sep);
            }
            const mi = document.createElement("div");
            mi.className = "mi" + (a.danger ? " danger" : "");
            const ic = svgIcon(a.icon); ic.classList.add("miIcon");
            mi.appendChild(ic);
            mi.appendChild(document.createTextNode(a.label));
            mi.addEventListener("click", () => runAction(s, a.id));
            ctxMenu.appendChild(mi);
        }
        ctxMenu.style.display = "block";
        const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
        ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
        ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
    }
    document.addEventListener("click", hideCtx);
    // Close on page scroll, but NOT when scrolling inside the menu's own list,
    // and NOT for programmatic auto-scroll of the log (new messages must not
    // close an open menu like the send-mode picker).
    document.addEventListener("scroll", (e) => {
        if (ctxMenu.contains(e.target)) { return; }
        if (Date.now() - lastAutoScroll < 200) { return; }
        hideCtx();
    }, true);

    // Right-click menu for a file referenced by a tool row.
    function showFileMenu(ev, path) {
        ev.preventDefault(); ev.stopPropagation();
        ctxMenu.textContent = "";
        const add = (icon, label, type) => {
            const mi = document.createElement("div"); mi.className = "mi";
            const ic = svgIcon(icon); ic.classList.add("miIcon");
            mi.appendChild(ic); mi.appendChild(document.createTextNode(label));
            mi.addEventListener("click", () => { hideCtx(); vscode.postMessage({ type, path }); });
            ctxMenu.appendChild(mi);
        };
        add("diff", "Open diff", "file-diff");
        add("file", "Open file", "open-file");
        ctxMenu.style.display = "block";
        const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
        ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
        ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
    }

    function makeChip(label, fullPath, onRemove, active, openPath) {
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
    function renderChips() {
        chips.querySelectorAll(".chip").forEach((el) => el.remove());
        // Active editor file as a removable context chip (like the native chat).
        // A preview tab (italic, not really opened) is shown as a SUGGESTION only:
        // dimmed/dashed, not auto-attached — click it to attach.
        if (activeFile && !activeFileDismissed) {
            const base = (activeFile.split("/").filter(Boolean).pop() || activeFile) + activeFileSuffix();
            const isSuggestion = activeFilePreview && !activeFilePinned;
            // Suggestion chip clicks to PIN; an attached chip clicks to OPEN.
            const chip = makeChip(base, activeFile + activeFileSuffix(), () => { activeFileDismissed = true; renderChips(); }, !isSuggestion, isSuggestion ? null : activeFile);
            if (isSuggestion) {
                chip.classList.add("suggestChip");
                chip.title = activeFile + activeFileSuffix() + " — preview (clique para anexar ao contexto)";
                chip.addEventListener("click", (e) => {
                    if (e.target && e.target.classList && e.target.classList.contains("x")) { return; }
                    activeFilePinned = true; renderChips();
                });
            }
            chips.appendChild(chip);
        }
        for (const file of attachments) {
            chips.appendChild(makeChip(file.name, file.path, () => {
                attachments = attachments.filter((a) => a.path !== file.path);
                renderChips();
            }, false, file.path));
        }
    }

    // Footer status bar: cwd · backend · permission/mode (like the native bar).
    const statusbar = document.getElementById("statusbar");
    let lastUsage = null, lastStatusData = {};
    function fmtTokens(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K" : String(n); }
    function renderStatusbar(data) {
        lastStatusData = data || lastStatusData;
        data = lastStatusData;
        statusbar.textContent = "";
        const seg = (iconName, text, title) => {
            const s = document.createElement("span"); s.className = "seg"; if (title) s.title = title;
            if (iconName) s.appendChild(svgIcon(iconName));
            s.appendChild(document.createTextNode(text));
            return s;
        };
        if (data.cwd) {
            const base = String(data.cwd).split("/").filter(Boolean).pop() || data.cwd;
            statusbar.appendChild(seg("terminal", base, data.cwd));
        }
        statusbar.appendChild(seg(null, data.backend + (data.permission && data.permission !== "default" ? " · " + data.permission : "")));
        if (data.reasoning && data.reasoning !== "default") statusbar.appendChild(seg(null, "effort: " + data.reasoning));
        if (lastUsage && lastUsage.contextWindow) {
            const pct = Math.min(100, Math.round((lastUsage.inputTokens || 0) / lastUsage.contextWindow * 100));
            const m = document.createElement("button"); m.className = "tokenMeter"; m.title = "Context window — click for details";
            const ring = document.createElement("span"); ring.className = "tmRing"; ring.style.background =
                "conic-gradient(var(--vscode-progressBar-background, #3794ff) " + pct + "%, var(--vscode-input-background, rgba(128,128,128,0.3)) 0)";
            m.appendChild(ring);
            m.appendChild(document.createTextNode(pct + "%"));
            m.addEventListener("click", (e) => { e.stopPropagation(); openUsagePopover(m); });
            const sp = document.createElement("span"); sp.className = "grow"; statusbar.appendChild(sp);
            statusbar.appendChild(m);
        }
    }
    function openUsagePopover(anchor) {
        const u = lastUsage; if (!u) { return; }
        const win = u.contextWindow || 0, used = u.inputTokens || 0;
        const pct = win ? Math.round(used / win * 100) : 0;
        ctxMenu.textContent = "";
        const box = document.createElement("div"); box.className = "usagePop";
        const row = (a, b, cls) => { const r = document.createElement("div"); r.className = "uRow " + (cls || ""); const x = document.createElement("span"); x.textContent = a; const y = document.createElement("span"); y.textContent = b; r.appendChild(x); r.appendChild(y); return r; };
        const h = document.createElement("div"); h.className = "uHead"; h.textContent = "Context Window"; box.appendChild(h);
        box.appendChild(row(fmtTokens(used) + " / " + fmtTokens(win) + " tokens", pct + "%", "uMain"));
        const bar = document.createElement("div"); bar.className = "uBar"; const fill = document.createElement("div"); fill.className = "uFill"; fill.style.width = pct + "%"; bar.appendChild(fill); box.appendChild(bar);
        const sub = document.createElement("div"); sub.className = "uGroup"; sub.textContent = "This turn"; box.appendChild(sub);
        box.appendChild(row("Output", fmtTokens(u.outputTokens || 0)));
        if (u.cacheRead) { box.appendChild(row("Cache read", fmtTokens(u.cacheRead))); }
        const btn = document.createElement("button"); btn.className = "uCompact"; btn.textContent = "Compact Conversation";
        btn.addEventListener("click", () => { hideCtx(); input.value = "/compact"; send(); });
        box.appendChild(btn);
        ctxMenu.appendChild(box);
        ctxMenu.style.display = "block";
        const r = anchor.getBoundingClientRect(); const w = ctxMenu.offsetWidth, ht = ctxMenu.offsetHeight;
        ctxMenu.style.left = Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4)) + "px";
        ctxMenu.style.top = Math.max(4, r.top - ht - 6) + "px";
    }

    // ---- edit & resend from an earlier user message ----
    let editAnchor = null;
    function markEditing() {
        log.querySelectorAll("[data-msg-index]").forEach((el) => {
            const i = Number(el.dataset.msgIndex || "-1");
            el.classList.toggle("willReplace", editAnchor != null && i >= editAnchor);
        });
        document.getElementById("composer").classList.toggle("editing", editAnchor != null);
    }
    // Most recent user turn (index + raw text), for "edit & retry".
    function lastUserRow() {
        for (let i = conversationRows.length - 1; i >= 0; i--) {
            if (conversationRows[i].role === "user") { return { idx: i, text: conversationRows[i].text || "" }; }
        }
        return null;
    }
    function beginEdit(idx, text) {
        editAnchor = idx;
        input.value = text;
        input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px";
        markEditing();
        input.focus();
    }
    function cancelEdit() {
        if (editAnchor == null) { return; }
        editAnchor = null; input.value = "";
        input.style.height = "auto";
        markEditing();
    }

    let lastSendPayload = null;   // last user submission, for error Retry
    function retryLast() {
        if (!lastSendPayload) { return; }
        vscode.postMessage(lastSendPayload);
        if (!busy) { busy = true; setStatus(); }
    }
    function send(modeOverride) {
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
        if (!busy && editFrom == null) { busy = true; setStatus(); }
        attachments = [];
        renderChips();
    }

    // ---- slash-command autocomplete ----
    const slash = document.getElementById("slash");
    let commands = [];     // [{name, description, kind}]
    let slashMatches = [];
    let slashSel = 0;

    function slashActive() { return slash.style.display === "block"; }

    function updateSlash() {
        const v = input.value;
        // Only when the line is a single "/token" (slash first, no whitespace yet).
        const oneToken = v.charAt(0) === "/" && v.indexOf(" ") === -1 && v.indexOf("\\n") === -1;
        if (!oneToken || !commands.length) { slash.style.display = "none"; return; }
        const q = v.slice(1).toLowerCase();
        slashMatches = commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 50);
        if (!slashMatches.length) { slash.style.display = "none"; return; }
        slashSel = Math.min(slashSel, slashMatches.length - 1);
        renderSlash();
        slash.style.display = "block";
    }
    function renderSlash() {
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
    function acceptSlash(i) {
        const c = slashMatches[i];
        if (!c) return;
        input.value = "/" + c.name + " ";
        slash.style.display = "none";
        slashSel = 0;
        input.focus();
    }

    // While a turn runs the button stops it; otherwise it sends.
    sendBtn.addEventListener("click", () => { send(); });
    addContext.addEventListener("click", () => vscode.postMessage({ type: "pick-attachments" }));
    const addBrowserPage = document.getElementById("addBrowserPage");
    if (addBrowserPage) {
        addBrowserPage.style.display = "none";   // shown only while a Simple Browser is open
        addBrowserPage.addEventListener("click", () => vscode.postMessage({ type: "attach-browser-page" }));
    }
    function setBrowserOpen(open) { if (addBrowserPage) { addBrowserPage.style.display = open ? "" : "none"; } }
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
    input.addEventListener("blur", () => { setTimeout(() => { slash.style.display = "none"; }, 120); });

    // Paste: images become attachments (written to a temp file by the
    // extension); text falls through to the textarea natively.
    function handlePaste(e) {
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
    // Single listener on the document (paste bubbles up from the textarea);
    // adding it to both the input and the document fired it twice.
    document.addEventListener("paste", handlePaste);

    window.addEventListener("message", ({ data }) => {
        switch (data.type) {
            case "boot": {
                if (data.complete) { clearTimeout(bootTimer); bootComplete(); break; }
                bootStep(data.id, data.label, data.status, data.detail);
                break;
            }
            case "meta": {
                sideMode = data.sessionsSide || "auto";
                // Seed the default send mode once (don't override a saved choice).
                if (data.whenBusy && !(saved && saved.sendMode)) { sendMode.value = data.whenBusy; }
                root.classList.toggle("chat-only", !!data.chatOnly);
                layout();   // apply the sessions-side now (meta sets sideMode)
                layout();
                activeSessionId = data.sessionId || "";
                clearTimeout(bootTimer); bootStep("host", null, "ok"); bootStep("session", "Sessão pronta", "ok"); bootComplete();
                startWorkingSet(activeSessionId);   // bind edited-files set to this session
                currentBackend = data.backend || "";
                currentBackendName = data.backendName || "";
                agentLabels = data.agentLabels || null;
                chatTitle.textContent = (data.title ? data.title + " · " : "") + (data.backendName || data.backend);
                setBrowserOpen(!!data.browserOpen);
                aiToolsAvailable = (data.aiTools && data.aiTools.available) || [];
                aiToolsEnabled = (data.aiTools && data.aiTools.enabled) || [];
                modelDefault = data.modelDefault || "";
                modelLabels = data.modelLabels || {};
                reasoningDefault = data.reasoningDefault || "";
                modelList = data.models || [];
                pinnedModels = data.pinnedModels || [];
                // Keep the user's chosen model across re-meta (e.g. edit-resend,
                // handoff) when it's still offered. Otherwise pick the right
                // starting model: a resumed session restores its last-used model
                // (data.sessionModel), a new session honors the configured default
                // (data.modelDefault), and only then falls back to the first model.
                if (!modelValue || (modelValue !== "default" && !modelList.includes(modelValue))) {
                    if (data.resumed && data.sessionModel) {
                        modelValue = data.sessionModel;
                    } else if (modelDefault && (modelDefault === "default" || modelList.includes(modelDefault))) {
                        modelValue = modelDefault;
                    } else {
                        modelValue = modelList[0] || "";
                    }
                }
                // Keep the picker visible even with an empty list: the menu
                // offers a manual-entry fallback so the user can always pick a
                // model (remote discovery may have failed, e.g. 401 / no login).
                modelPicker.disabled = false;
                modelPicker.style.display = "";
                setModelLabel();
                reasoningList = data.reasoningLevels || [];
                reasoningValue = reasoningList[0] || "default";
                reasoningPicker.disabled = false;
                reasoningPicker.style.display = reasoningList.length ? "" : "none";
                setReasoningLabel();
                permissionModes = data.permissionModes || [];
                permissionValue = data.permission || "default";
                permissionDefault = data.permission || "default";
                configBtn.style.display = (permissionModes.length || true) ? "" : "none";
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
                activeFile = data.activeFile || null;
                activeFileRange = (data.activeFileStart && data.activeFileEnd) ? { start: data.activeFileStart, end: data.activeFileEnd } : null;
                activeFilePreview = !!data.activeFilePreview; activeFilePinned = false;
                activeFileDismissed = false; renderChips();
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
                if (data.path !== activeFile) { activeFileDismissed = false; activeFilePinned = false; }
                activeFile = data.path || null;
                activeFileRange = (data.start && data.end) ? { start: data.start, end: data.end } : null;
                activeFilePreview = !!data.preview;
                renderChips();
                break;
            }
            case "prefs": {
                // Live preference updates (no reload needed), e.g. sessions side.
                if (typeof data.sessionsSide === "string") { sideMode = data.sessionsSide; layout(); }
                break;
            }
            case "clear": {
                conversationRows = [];
                log.textContent = "";
                activeModel = ""; busy = false; queued = 0;
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
                sessions = data.items;
                renderSessions();
                break;
            }
            case "account": {
                renderAccount(data.profile);
                break;
            }
            case "commands": {
                commands = data.items || [];
                break;
            }
            case "models": {
                // Async refresh after meta (remote discovery landed). Repopulate
                // the picker, keep the user's current pick if it survived, else
                // fall back to the first entry. Don't clobber an explicit
                // "default" selection.
                const newList = data.models || [];
                if (newList.length) {
                    modelList = newList;
                    modelLabels = data.labels || modelLabels;
                    if (modelValue && modelValue !== "default" && !modelList.includes(modelValue)) {
                        modelValue = modelList[0] || "";
                    } else if (!modelValue) {
                        modelValue = modelList[0] || "";
                    }
                    modelPicker.disabled = false;
                    modelPicker.style.display = "";
                    setModelLabel();
                    setStatus();   // refresh "model: <name>" with the friendly label
                }
                break;
            }
            case "model-prefs": {
                if (Array.isArray(data.pinnedModels)) { pinnedModels = data.pinnedModels; }
                if (data.modelDefault !== undefined) { modelDefault = data.modelDefault; setModelLabel(); }
                break;
            }
            case "history": {
                lastMsgBackend = ""; lastMsgModel = ""; // reset so first message in loaded session always shows label
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
                pendingSessionSwitch = null;
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
                if (data.attachments?.length) {
                    const list = document.createElement("div");
                    list.className = "msgAtts";
                    for (const p of data.attachments) {
                        const a = document.createElement("span"); a.className = "msgAtt";
                        a.title = "Abrir " + p;
                        const ic = svgIcon("file"); ic.classList.add("chipIcon"); a.appendChild(ic);
                        // strip any " (selected lines …)" suffix for the path to open
                        // NOTE: use [(] instead of \\( — this string is emitted inside a
                        // template literal, where \\( collapses to ( and breaks the regex.
                        const cleanPath = String(p).replace(/ [(]selected lines.*$/, "");
                        const lbl = document.createElement("span"); lbl.textContent = String(p).split("/").pop();
                        a.appendChild(lbl);
                        a.addEventListener("click", () => vscode.postMessage({ type: "open-file", path: cleanPath }));
                        list.appendChild(a);
                    }
                    el.appendChild(list);
                }
                busy = true; setStatus();   // a turn just started (covers queued flush)
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
                changedItems = data.items || [];
                renderChangedFiles();
                break;
            }
            case "tasks": {
                renderTasks(data.items || [], data.project || "");
                break;
            }
            case "event": {
                const ev = data.event;
                if (ev.kind === "thinking") streamThinkingDelta(ev.text);
                else if (ev.kind === "text") streamDelta(ev.text);
                else if (ev.kind === "tool-start") { endStream(); renderTool(ev.toolName, ev.detail || "", { toolId: ev.toolId, input: ev.input, added: ev.added, removed: ev.removed, todos: ev.todos, path: ev.path }); }
                else if (ev.kind === "tool-output") fillToolResult(ev.toolId, ev.text);
                else if (ev.kind === "tool-end") fillToolResult(ev.toolId, ev.result);
                else if (ev.kind === "usage") { lastUsage = ev; renderStatusbar(); }
                else if (ev.kind === "error") {
                    // Defensive: an error must never leave the composer stuck busy.
                    busy = false; sendBtn.disabled = false; setStatus();
                    renderError(ev.message);
                }
                else if (ev.kind === "session") {
                    if (ev.model) {
                        activeModel = ev.model;
                        if (modelList.includes(ev.model)) { modelValue = ev.model; setModelLabel(); }
                    }
                    activeSessionId = ev.sessionId || activeSessionId;
                    bindWorkingSet(ev.sessionId);
                    if (agentLabels) {
                        const parts = ["agent: " + agentLabels.agent, "model: " + (ev.model ? modelLabel(ev.model) : "default"), "backend: " + (currentBackendName || currentBackend)];
                        if (agentLabels.toolsDeclared && agentLabels.toolsDeclared.length) { parts.push("tools: " + agentLabels.toolsDeclared.join(", ")); }
                        append("meta", parts.join(" · "));
                        // only once, so re-opening a saved session won't show stale agent badges
                        agentLabels = null;
                    }
                    append("meta", "session " + ev.sessionId + (ev.model ? " · " + modelLabel(ev.model) : ""));
                    setStatus();
                }
                else if (ev.kind === "turn-end") {
                    busy = false; sendBtn.disabled = false; setStatus();
                    append("meta", "—" + (ev.costUsd ? " $" + ev.costUsd.toFixed(4) : "") + (ev.durationMs ? " " + (ev.durationMs/1000).toFixed(1) + "s" : "") + " —");
                }
                break;
            }
        }
    });

    // Boot screen: shows immediately on parse, hides once a session resolves.
    // the first session meta/history marks boot complete and hides the overlay.
    const BOOT_ICONS = {
        ok: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 11.6 3.4 8.5l-1 1 4.1 4.1L14 6.1l-1-1Z"/></svg>',
        fail: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3 9.3-.7.7L8 8.7 5.7 11l-.7-.7L7.3 8 5 5.7l.7-.7L8 7.3 10.3 5l.7.7L8.7 8Z"/></svg>'
    };
    const bootStepsEl = document.getElementById("bootSteps");
    const bootHintEl = document.getElementById("bootHint");
    const bootSteps = new Map();
    let bootDone = false;
    function renderBootStep(id, label, status, detail) {
        if (!bootStepsEl) { return; }
        try {
            let row = bootSteps.get(id);
            if (!row) {
                row = document.createElement("div");
                row.className = "bootStep";
                const ic = document.createElement("span"); ic.className = "bsIcon";
                const lb = document.createElement("span"); lb.className = "bsLabel";
                const dt = document.createElement("span"); dt.className = "bsDetail";
                row.appendChild(ic); row.appendChild(lb); row.appendChild(dt);
                bootStepsEl.appendChild(row);
                bootSteps.set(id, row);
            }
            if (label != null) { row.querySelector(".bsLabel").textContent = label; }
            if (detail != null) { row.querySelector(".bsDetail").textContent = detail; }
            const st = status || "pending";
            row.className = "bootStep " + st;
            const ic = row.querySelector(".bsIcon");
            ic.innerHTML = st === "pending" ? '<span class="bsSpin"></span>' : (BOOT_ICONS[st] || "");
        } catch (e) { /* best-effort — never block script init */ }
    }
    function bootStep(id, label, status, detail) {
        if (bootDone && status === "ok") { return; }
        renderBootStep(id, label, status, detail);
    }
    function bootComplete() {
        if (bootDone) { return; }
        bootDone = true;
        try { clearTimeout(bootForce); } catch (e) {}
        root.classList.add("booted");
    }
    // Seed the steps we know about up front (extension confirms/overrides them).
    try { bootStep("host", "Conectando ao host da extensão", "pending"); } catch (e) {}
    try { bootStep("ui", "Carregando interface", "ok"); } catch (e) {}
    try { bootStep("session", "Preparando sessão", "pending"); } catch (e) {}
    // Safety: never trap the user behind the boot screen. After a short grace
    // period surface a warning; shortly after, force-reveal the UI even if the
    // extension never resolved the session (e.g. a backend's discovery hung).
    const bootTimer = setTimeout(() => {
        if (bootDone) { return; }
        if (bootHintEl) { bootHintEl.textContent = "Demorando mais que o esperado — veja Output › Symposium para diagnóstico."; }
    }, 8000);
    const bootForce = setTimeout(() => {
        if (bootDone) { return; }
        bootStep("session", "Preparando sessão", "warn", "tempo esgotado");
        bootComplete();   // reveal the composer/list anyway so the user can act
    }, 15000);

    setStatus();
    refreshEmpty();   // show the placeholder until a conversation loads
    // Handshake: the extension queues everything until this script is live,
    // so meta/history posted right after construction are never lost.
    vscode.postMessage({ type: "ready" });`;
