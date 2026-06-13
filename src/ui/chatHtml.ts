/**
 * Shared chat webview markup for the sidebar view and the editor panel.
 *
 * Master-detail layout mirroring the built-in Chat sessions viewer: a
 * sessions list pane beside the conversation, shown automatically when the
 * surface is wide enough and collapsible behind a toggle when narrow. The
 * pane side (left/right) comes from the `meta` message.
 */
export function renderHtml(): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        height: 100vh; margin: 0; padding: 0; overflow: hidden;
    }
    #root { display: flex; height: 100vh; }

    /* ---- sessions pane ---- */
    #sessionsPane {
        width: 260px; min-width: 200px; flex-shrink: 0;
        border-right: 1px solid var(--vscode-panel-border, #333);
        display: flex; flex-direction: column; overflow: hidden;
    }
    #root.side-right #sessionsPane {
        order: 2;
        border-right: none;
        border-left: 1px solid var(--vscode-panel-border, #333);
    }
    #root.narrow #sessionsPane { display: none; }
    #root.chat-only #sessionsPane { display: none; }
    #root.chat-only #listToggle { display: none; }
    #root.narrow.listOpen #sessionsPane {
        display: flex; position: absolute; z-index: 10; height: 100vh;
        background: var(--vscode-editor-background);
        box-shadow: 0 0 12px rgba(0,0,0,0.4);
    }
    #sessionsHeader {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; opacity: 0.8; font-size: 0.85em; text-transform: uppercase;
    }
    #sessionsList { flex: 1; overflow-y: auto; }
    .sessionItem {
        padding: 6px 10px; cursor: pointer; border-left: 2px solid transparent;
        display: flex; align-items: center; gap: 6px;
    }
    .sessionItem:hover { background: var(--vscode-list-hoverBackground); }
    .sessionItem.active {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        border-left-color: var(--vscode-focusBorder);
    }
    .sessionItem .body { flex: 1; min-width: 0; }
    .sessionItem .ttl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sessionItem .sub { opacity: 0.6; font-size: 0.82em; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sessionItem.archived .ttl { opacity: 0.6; font-style: italic; }
    .sessionItem .acts { display: none; flex-shrink: 0; gap: 1px; }
    .sessionItem:hover .acts { display: flex; }
    .sessionItem .acts button {
        background: none; border: none; cursor: pointer; padding: 2px 3px;
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
        border-radius: 3px; font-size: 0.95em; line-height: 1;
    }
    .sessionItem .acts button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25)); }
    #ctxMenu {
        position: fixed; z-index: 50; display: none; min-width: 160px;
        background: var(--vscode-menu-background, var(--vscode-editor-background));
        color: var(--vscode-menu-foreground, var(--vscode-foreground));
        border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #454545));
        border-radius: 5px; padding: 4px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    }
    #ctxMenu .mi { padding: 5px 14px; cursor: pointer; font-size: 0.9em; white-space: nowrap; }
    #ctxMenu .mi:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
    #ctxMenu .mi.danger { color: var(--vscode-errorForeground); }
    #ctxMenu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, rgba(128,128,128,0.3)); }

    /* ---- chat column ---- */
    #chatCol { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    #chatHeader {
        display: flex; align-items: center; gap: 8px; padding: 4px 10px;
        border-bottom: 1px solid var(--vscode-panel-border, transparent);
        min-height: 26px;
    }
    #chatTitle { flex: 1; opacity: 0.75; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #listToggle { display: none; }
    #root.narrow #listToggle { display: inline-flex; }
    #log { flex: 1; overflow-y: auto; padding: 12px 14px 4px 14px; user-select: text; cursor: text; }
    .msg { margin: 0 0 12px 0; white-space: pre-wrap; word-break: break-word; line-height: 1.5; user-select: text; -webkit-user-select: text; }
    .user {
        background: var(--vscode-chat-requestBackground, var(--vscode-input-background));
        border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, transparent));
        border-radius: 6px; padding: 8px 10px;
    }
    .tool { opacity: 0.65; font-size: 0.92em; padding-left: 4px; }
    .error { color: var(--vscode-errorForeground); }
    .meta { opacity: 0.5; font-size: 0.85em; text-align: center; }

    /* ---- slash command autocomplete ---- */
    #slash {
        position: absolute; z-index: 40; display: none;
        left: 12px; right: 12px; bottom: 100%; margin-bottom: 2px;
        max-height: 240px; overflow-y: auto;
        background: var(--vscode-editorSuggestWidget-background, var(--vscode-menu-background, var(--vscode-editor-background)));
        border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-widget-border, #454545));
        border-radius: 5px; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    }
    .slashItem { padding: 5px 10px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
    .slashItem.sel { background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); }
    .slashItem .nm { color: var(--vscode-editorSuggestWidget-foreground, inherit); font-weight: 600; white-space: nowrap; }
    .slashItem .ds { opacity: 0.65; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ---- composer ---- */
    #composer { position: relative; }
    #composer {
        margin: 6px 12px 10px 12px;
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #454545));
        border-radius: 8px;
        background: var(--vscode-input-background);
        display: flex; flex-direction: column;
    }
    #composer:focus-within { border-color: var(--vscode-focusBorder); }
    #chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 0 8px; }
    .chip {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 0.85em; padding: 1px 6px;
        border: 1px solid var(--vscode-input-border, #454545);
        border-radius: 4px;
        background: var(--vscode-badge-background, rgba(128,128,128,0.15));
        color: var(--vscode-badge-foreground, inherit);
        max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .chip .x { cursor: pointer; opacity: 0.7; }
    .chip .x:hover { opacity: 1; }
    #addContext {
        background: none; border: 1px dashed var(--vscode-input-border, #666);
        color: var(--vscode-descriptionForeground); cursor: pointer;
        border-radius: 4px; font-size: 0.85em; padding: 1px 8px;
    }
    #addContext:hover { color: var(--vscode-foreground); }
    #input {
        border: none; outline: none; resize: none;
        background: transparent; color: var(--vscode-input-foreground);
        font-family: inherit; font-size: inherit;
        padding: 8px 10px; min-height: 38px; max-height: 180px;
    }
    #toolbar { display: flex; align-items: center; gap: 6px; padding: 2px 6px 6px 8px; }
    #modelPicker {
        background: transparent; color: var(--vscode-descriptionForeground);
        border: none; outline: none; cursor: pointer;
        font-family: inherit; font-size: 0.9em; max-width: 200px;
    }
    #modelPicker:hover:not(:disabled) { color: var(--vscode-foreground); }
    #modelPicker:disabled { cursor: default; opacity: 0.8; }
    #modelPicker option, #reasoningPicker option {
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
    }
    #reasoningPicker {
        background: transparent; color: var(--vscode-descriptionForeground);
        border: none; outline: none; cursor: pointer;
        font-family: inherit; font-size: 0.9em; max-width: 130px;
    }
    #reasoningPicker:hover:not(:disabled) { color: var(--vscode-foreground); }
    #reasoningPicker:disabled { cursor: default; opacity: 0.8; }
    #sendMode {
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        border: 1px solid var(--vscode-input-border, #454545); border-radius: 4px;
        cursor: pointer; font-family: inherit; font-size: 0.85em; padding: 1px 4px;
    }
    #sendMode option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
    #status { flex: 1; text-align: right; opacity: 0.5; font-size: 0.85em; padding-right: 4px; }
    .iconBtn {
        background: none; border: none; cursor: pointer; padding: 3px 5px;
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
        border-radius: 4px; display: inline-flex; align-items: center;
    }
    .iconBtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    #send svg { width: 16px; height: 16px; }
    #send:disabled { opacity: 0.4; cursor: default; }
</style>
</head>
<body>
<div id="root">
    <aside id="sessionsPane">
        <div id="sessionsHeader">
            <span>Sessions</span>
            <span>
                <button id="newSessionBtn" class="iconBtn" title="New session">＋</button>
                <button id="archToggle" class="iconBtn" title="Show/hide archived">🗄</button>
            </span>
        </div>
        <div id="sessionsList"></div>
    </aside>
    <main id="chatCol">
        <div id="chatHeader">
            <button id="listToggle" class="iconBtn" title="Sessions">☰</button>
            <span id="chatTitle"></span>
        </div>
        <div id="log"></div>
        <div id="composer">
            <div id="slash"></div>
            <div id="chips">
                <button id="addContext" title="Attach files">📎 Add Context...</button>
            </div>
            <textarea id="input" placeholder="Ask the agent... (Enter sends, Shift+Enter newline)"></textarea>
            <div id="toolbar">
                <select id="modelPicker" title="Model for this session (locked after the first message)"></select>
                <select id="reasoningPicker" title="Reasoning/thinking effort (locked after the first message)"></select>
                <span id="status"></span>
                <select id="sendMode" title="Send behavior">
                    <option value="send">Send</option>
                    <option value="queue">Queue</option>
                    <option value="steer">Steer</option>
                </select>
                <button id="send" class="iconBtn" title="Send (Enter)">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.176 2.824 3.06 8 1.176 13.176a.5.5 0 0 0 .708.605l13-5.5a.5.5 0 0 0 0-.918l-13-5.5a.5.5 0 0 0-.708.605L1.176 2.824ZM3.92 8.5 2.32 12.9l10.36-4.4H3.92Zm8.76-1L2.32 3.1l1.6 4.4h8.76Z"/></svg>
                </button>
            </div>
        </div>
    </main>
</div>
<div id="ctxMenu"></div>
<script>
    const vscode = acquireVsCodeApi();
    window.addEventListener("error", (e) => {
        vscode.postMessage({ type: "webview-error", message: (e.message || "error") + " @" + (e.lineno || "?") });
    });
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
    let activeModel = "";
    let activeSessionId = "";
    let busy = false;
    let queued = 0;
    let sessions = [];
    let showArchived = false;

    document.getElementById("newSessionBtn").addEventListener("click", () => vscode.postMessage({ type: "new-session" }));
    document.getElementById("archToggle").addEventListener("click", () => { showArchived = !showArchived; renderSessions(); });

    // Remember the chosen send mode across reloads.
    const saved = vscode.getState && vscode.getState();
    if (saved && saved.sendMode) { sendMode.value = saved.sendMode; }
    sendMode.addEventListener("change", () => vscode.setState && vscode.setState({ sendMode: sendMode.value }));

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

    function append(cls, text) {
        const el = document.createElement("div");
        el.className = "msg " + cls;
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el;
    }

    function setStatus() {
        const q = queued > 0 ? " · " + queued + " queued" : "";
        status.textContent = busy ? ("thinking..." + q) : (activeModel ? "model: " + activeModel : "");
    }

    // Per-session actions, shown as hover icons on the right and in the
    // right-click menu. Each posts a session-action the extension handles.
    function actionsFor(s) {
        const list = [
            { id: "open", icon: "▷", label: "Resume in terminal" },
            { id: "rename", icon: "✎", label: "Rename" },
            { id: "watch", icon: "👁", label: "Watch live (read-only)" },
        ];
        list.push(s.archived
            ? { id: "unarchive", icon: "↩", label: "Unarchive" }
            : { id: "archive", icon: "🗄", label: "Archive" });
        list.push({ id: "delete", icon: "🗑", label: "Delete permanently", danger: true });
        return list;
    }

    function runAction(s, action) {
        hideCtx();
        vscode.postMessage({ type: "session-action", action, sessionId: s.sessionId, backend: s.backend });
    }

    function renderSessions() {
        sessionsList.textContent = "";
        for (const s of sessions) {
            if (s.archived && !showArchived) continue;
            const el = document.createElement("div");
            el.className = "sessionItem" + (s.sessionId === activeSessionId ? " active" : "") + (s.archived ? " archived" : "");

            const body = document.createElement("div");
            body.className = "body";
            const ttl = document.createElement("div");
            ttl.className = "ttl";
            ttl.textContent = (s.archived ? "🗄 " : "") + s.title;
            ttl.title = s.title + "\\n" + s.sessionId;
            const sub = document.createElement("span");
            sub.className = "sub";
            sub.textContent = s.backend + (s.updatedAt ? " · " + new Date(s.updatedAt).toLocaleString() : "");
            body.appendChild(ttl);
            body.appendChild(sub);
            body.addEventListener("click", () => {
                root.classList.remove("listOpen");
                vscode.postMessage({ type: "open-session", sessionId: s.sessionId, backend: s.backend });
            });

            const acts = document.createElement("div");
            acts.className = "acts";
            for (const a of actionsFor(s)) {
                const b = document.createElement("button");
                b.textContent = a.icon;
                b.title = a.label;
                b.addEventListener("click", (ev) => { ev.stopPropagation(); runAction(s, a.id); });
                acts.appendChild(b);
            }

            el.appendChild(body);
            el.appendChild(acts);
            el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); showCtx(ev, s); });
            sessionsList.appendChild(el);
        }
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
            mi.textContent = a.icon + "  " + a.label;
            mi.addEventListener("click", () => runAction(s, a.id));
            ctxMenu.appendChild(mi);
        }
        ctxMenu.style.display = "block";
        const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
        ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - w - 4) + "px";
        ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - h - 4) + "px";
    }
    document.addEventListener("click", hideCtx);
    document.addEventListener("scroll", hideCtx, true);

    function renderChips() {
        chips.querySelectorAll(".chip").forEach((el) => el.remove());
        for (const file of attachments) {
            const chip = document.createElement("span");
            chip.className = "chip";
            chip.title = file.path;
            chip.textContent = "📄 " + file.name + " ";
            const x = document.createElement("span");
            x.className = "x";
            x.textContent = "✕";
            x.addEventListener("click", () => {
                attachments = attachments.filter((a) => a.path !== file.path);
                renderChips();
            });
            chip.appendChild(x);
            chips.appendChild(chip);
        }
    }

    function send() {
        const text = input.value.trim();
        if (!text) return;
        // While a turn runs, only queue/steer may submit; plain send waits too
        // (the extension queues it), so allow submitting in every mode.
        input.value = "";
        modelPicker.disabled = true;
        reasoningPicker.disabled = true;
        vscode.postMessage({
            type: "send",
            text,
            attachments: attachments.map((a) => a.path),
            model: modelPicker.value,
            reasoning: reasoningPicker.value,
            mode: sendMode.value,
        });
        if (!busy) { busy = true; setStatus(); }
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

    sendBtn.addEventListener("click", send);
    addContext.addEventListener("click", () => vscode.postMessage({ type: "pick-attachments" }));
    input.addEventListener("keydown", (e) => {
        if (slashActive()) {
            if (e.key === "ArrowDown") { e.preventDefault(); slashSel = (slashSel + 1) % slashMatches.length; renderSlash(); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); slashSel = (slashSel - 1 + slashMatches.length) % slashMatches.length; renderSlash(); return; }
            if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); acceptSlash(slashSel); return; }
            if (e.key === "Escape") { e.preventDefault(); slash.style.display = "none"; return; }
        }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        if (e.key === "Escape" && busy) { vscode.postMessage({ type: "cancel" }); }
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
            case "meta": {
                sideMode = data.sessionsSide || "auto";
                // Seed the default send mode once (don't override a saved choice).
                if (data.defaultSendMode && !(saved && saved.sendMode)) { sendMode.value = data.defaultSendMode; }
                root.classList.toggle("chat-only", !!data.chatOnly);
                layout();
                activeSessionId = data.sessionId || "";
                chatTitle.textContent = (data.title ? data.title + " · " : "") + data.backend;
                modelPicker.textContent = "";
                modelPicker.disabled = false;
                for (const m of data.models) {
                    const opt = document.createElement("option");
                    opt.value = m; opt.textContent = m;
                    modelPicker.appendChild(opt);
                }
                modelPicker.style.display = data.models.length ? "" : "none";
                reasoningPicker.textContent = "";
                reasoningPicker.disabled = false;
                for (const r of (data.reasoningLevels || [])) {
                    const opt = document.createElement("option");
                    opt.value = r; opt.textContent = r === "default" ? "reasoning: default" : "reasoning: " + r;
                    reasoningPicker.appendChild(opt);
                }
                reasoningPicker.style.display = (data.reasoningLevels && data.reasoningLevels.length) ? "" : "none";
                document.getElementById("composer").style.display = data.readOnly ? "none" : "flex";
                if (data.readOnly) {
                    append("meta", "👁 watching live — read only (this session runs elsewhere)");
                } else if (data.terminal) {
                    append("meta", "▷ terminal session — drive it here or type in the terminal panel" + (data.resumed ? " (resumed)" : ""));
                } else {
                    append("meta", data.backend + (data.resumed ? " · resumed session" : " · new session"));
                }
                renderSessions();
                break;
            }
            case "clear": {
                log.textContent = "";
                activeModel = ""; busy = false; queued = 0;
                sendBtn.disabled = false;
                document.getElementById("composer").style.display = "flex";
                setStatus();
                break;
            }
            case "queued": {
                queued = data.count || 0;
                append("meta", "↳ queued (" + queued + " waiting)");
                setStatus();
                break;
            }
            case "append": {
                const m = data.message;
                if (m.role === "user") append("user", m.text);
                else if (m.role === "tool") append("tool", m.text);
                else append("", m.text);
                break;
            }
            case "sessions": {
                sessions = data.items;
                renderSessions();
                break;
            }
            case "commands": {
                commands = data.items || [];
                break;
            }
            case "history": {
                for (const m of data.messages) {
                    if (m.role === "user") append("user", m.text);
                    else if (m.role === "tool") append("tool", m.text);
                    else append("", m.text);
                }
                append("meta", data.messages.length ? "— end of stored transcript —" : "(empty transcript)");
                break;
            }
            case "user": {
                const el = append("user", data.text);
                if (data.attachments?.length) {
                    const list = document.createElement("div");
                    list.className = "tool";
                    list.textContent = "📎 " + data.attachments.map((p) => p.split("/").pop()).join(", ");
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
            case "event": {
                const ev = data.event;
                if (ev.kind === "text") append("", ev.text);
                else if (ev.kind === "tool-start") append("tool", "⚙ " + ev.toolName + " " + (ev.detail || ""));
                else if (ev.kind === "error") append("error", "✖ " + ev.message);
                else if (ev.kind === "session") {
                    if (ev.model) { activeModel = ev.model; }
                    activeSessionId = ev.sessionId || activeSessionId;
                    append("meta", "session " + ev.sessionId + (ev.model ? " · " + ev.model : ""));
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

    setStatus();
    // Handshake: the extension queues everything until this script is live,
    // so meta/history posted right after construction are never lost.
    vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
