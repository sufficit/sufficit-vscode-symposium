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
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sessionItem:hover { background: var(--vscode-list-hoverBackground); }
    .sessionItem.active {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        border-left-color: var(--vscode-focusBorder);
    }
    .sessionItem .sub { opacity: 0.6; font-size: 0.82em; display: block; }

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
    #log { flex: 1; overflow-y: auto; padding: 12px 14px 4px 14px; }
    .msg { margin: 0 0 12px 0; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
    .user {
        background: var(--vscode-chat-requestBackground, var(--vscode-input-background));
        border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, transparent));
        border-radius: 6px; padding: 8px 10px;
    }
    .tool { opacity: 0.65; font-size: 0.92em; padding-left: 4px; }
    .error { color: var(--vscode-errorForeground); }
    .meta { opacity: 0.5; font-size: 0.85em; text-align: center; }

    /* ---- composer ---- */
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
    #modelPicker option {
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
    }
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
        <div id="sessionsHeader"><span>Sessions</span></div>
        <div id="sessionsList"></div>
    </aside>
    <main id="chatCol">
        <div id="chatHeader">
            <button id="listToggle" class="iconBtn" title="Sessions">☰</button>
            <span id="chatTitle"></span>
        </div>
        <div id="log"></div>
        <div id="composer">
            <div id="chips">
                <button id="addContext" title="Attach files">📎 Add Context...</button>
            </div>
            <textarea id="input" placeholder="Ask the agent... (Enter sends, Shift+Enter newline)"></textarea>
            <div id="toolbar">
                <select id="modelPicker" title="Model for this session (locked after the first message)"></select>
                <span id="status"></span>
                <button id="send" class="iconBtn" title="Send (Enter)">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.176 2.824 3.06 8 1.176 13.176a.5.5 0 0 0 .708.605l13-5.5a.5.5 0 0 0 0-.918l-13-5.5a.5.5 0 0 0-.708.605L1.176 2.824ZM3.92 8.5 2.32 12.9l10.36-4.4H3.92Zm8.76-1L2.32 3.1l1.6 4.4h8.76Z"/></svg>
                </button>
            </div>
        </div>
    </main>
</div>
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
    const sendBtn = document.getElementById("send");
    const status = document.getElementById("status");
    const sessionsList = document.getElementById("sessionsList");
    const chatTitle = document.getElementById("chatTitle");
    const listToggle = document.getElementById("listToggle");

    let attachments = [];   // [{path, name}]
    let activeModel = "";
    let activeSessionId = "";
    let busy = false;
    let sessions = [];

    // Responsive: a wide surface shows the sessions pane beside the chat,
    // a narrow one hides it behind the toggle — same feel as the built-in
    // chat sessions viewer.
    const NARROW = 640;
    function layout() {
        root.classList.toggle("narrow", document.body.clientWidth < NARROW);
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
        status.textContent = busy ? "thinking..." : (activeModel ? "model: " + activeModel : "");
    }

    function renderSessions() {
        sessionsList.textContent = "";
        for (const s of sessions) {
            const el = document.createElement("div");
            el.className = "sessionItem" + (s.sessionId === activeSessionId ? " active" : "");
            el.title = s.title;
            el.textContent = s.title;
            const sub = document.createElement("span");
            sub.className = "sub";
            sub.textContent = s.backend + (s.updatedAt ? " · " + new Date(s.updatedAt).toLocaleString() : "");
            el.appendChild(sub);
            el.addEventListener("click", () => {
                root.classList.remove("listOpen");
                vscode.postMessage({ type: "open-session", sessionId: s.sessionId, backend: s.backend });
            });
            sessionsList.appendChild(el);
        }
    }

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
        if (!text || busy) return;
        input.value = "";
        busy = true; sendBtn.disabled = true; setStatus();
        modelPicker.disabled = true;
        vscode.postMessage({
            type: "send",
            text,
            attachments: attachments.map((a) => a.path),
            model: modelPicker.value,
        });
        attachments = [];
        renderChips();
    }

    sendBtn.addEventListener("click", send);
    addContext.addEventListener("click", () => vscode.postMessage({ type: "pick-attachments" }));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        if (e.key === "Escape" && busy) { vscode.postMessage({ type: "cancel" }); }
    });
    input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 180) + "px";
    });

    window.addEventListener("message", ({ data }) => {
        switch (data.type) {
            case "meta": {
                root.classList.toggle("side-right", data.sessionsSide === "right");
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
                document.getElementById("composer").style.display = data.readOnly ? "none" : "flex";
                if (data.readOnly) {
                    append("meta", "👁 watching live — read only (this session runs elsewhere)");
                } else {
                    append("meta", data.backend + (data.resumed ? " · resumed session" : " · new session"));
                }
                renderSessions();
                break;
            }
            case "clear": {
                log.textContent = "";
                activeModel = ""; busy = false;
                sendBtn.disabled = false;
                document.getElementById("composer").style.display = "flex";
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
