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
        /* transparent: inherit the host view background (editor vs sidebar) so
           the chat background always matches the native chat in that location. */
        background: transparent;
        height: 100vh; margin: 0; padding: 0; overflow: hidden;
    }
    *:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    #root { display: flex; height: 100vh; position: relative; }

    /* ---- progress + loading indicators ---- */
    #progress {
        position: absolute; top: 0; left: 0; right: 0; height: 2px; z-index: 60;
        overflow: hidden; opacity: 0; transition: opacity 150ms ease;
        background: color-mix(in srgb, var(--vscode-progressBar-background, #0e70c0) 25%, transparent);
    }
    #progress.on { opacity: 1; }
    #progress::before {
        content: ""; position: absolute; height: 100%; width: 40%; left: -40%;
        background: var(--vscode-progressBar-background, #0e70c0);
        animation: slide 1.1s ease-in-out infinite;
    }
    @keyframes slide { 0% { left: -40%; } 50% { left: 40%; } 100% { left: 100%; } }
    .spinner {
        display: inline-block; width: 14px; height: 14px; vertical-align: -2px;
        border: 2px solid color-mix(in srgb, var(--vscode-foreground) 25%, transparent);
        border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
        border-radius: 50%; animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #loadingState {
        display: none; flex-direction: column; align-items: center; justify-content: center;
        gap: 10px; flex: 1; opacity: 0.7; font-size: 0.9em;
    }
    #root.loading #loadingState { display: flex; }
    #root.loading #log { display: none; }
    @media (prefers-reduced-motion: reduce) {
        #progress::before, .spinner { animation: none; }
        #progress.on { opacity: 1; }
    }

    /* ---- sessions pane ---- */
    #sessionsPane {
        order: 1; width: 260px; min-width: 180px; flex-shrink: 0;
        border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
        display: flex; flex-direction: column; overflow: hidden;
    }
    #root.side-right #sessionsPane {
        order: 3;
        border-right: none;
        border-left: 1px solid var(--vscode-panel-border, #333);
    }
    #root.side-right #chatCol { order: 1; }
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
    .groupHeader {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px 4px 12px; font-size: 0.72em; text-transform: uppercase;
        letter-spacing: 0.04em; opacity: 0.6; font-weight: 600;
    }
    .groupHeader .gcount { opacity: 0.6; font-weight: 400; font-variant-numeric: tabular-nums; }
    .sessionItem {
        padding: 7px 10px; cursor: pointer; border-left: 2px solid transparent;
        display: flex; align-items: center; gap: 8px;
    }
    .sessionItem .statusDot .stored { width: 13px; height: 13px; opacity: 0.4; }
    .sessionItem.active .statusDot .stored { opacity: 0.7; }
    .sessionItem .ttl { line-height: 1.35; }
    .sessionItem .sub { margin-top: 1px; }
    .sessionItem:hover { background: var(--vscode-list-hoverBackground); }
    .sessionItem.active {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        border-left-color: var(--vscode-focusBorder);
    }
    .sessionItem .statusDot { width: 14px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    .sessionItem .statusDot .idle { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green, #89d185); opacity: 0.8; }
    .sessionItem .statusDot .work {
        width: 11px; height: 11px; border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 30%, transparent);
        border-top-color: var(--vscode-charts-blue, #3794ff);
        animation: spin 0.7s linear infinite;
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
    .sessionItem .acts button { display: inline-flex; align-items: center; }
    .sessionItem .acts button svg { width: 14px; height: 14px; }
    .sessionItem .acts button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25)); }
    .sessionItem .acts button.danger:hover { color: var(--vscode-errorForeground); }
    .ttlIcon { width: 12px; height: 12px; vertical-align: -1px; margin-right: 4px; opacity: 0.7; }
    #ctxMenu .miIcon { width: 14px; height: 14px; vertical-align: -2px; margin-right: 8px; opacity: 0.85; }
    #ctxMenu .mi { display: flex; align-items: center; }
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
    #ctxMenu { max-width: 340px; }
    #ctxMenu .menuSearch {
        display: block; width: calc(100% - 16px); margin: 4px 8px 6px 8px; padding: 4px 7px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #454545); border-radius: 4px; outline: none; font-family: inherit; font-size: 0.9em;
    }
    #ctxMenu .menuSearch:focus { border-color: var(--vscode-focusBorder); }
    #ctxMenu .menuList { max-height: 320px; overflow-y: auto; }
    #ctxMenu .menuGroup { padding: 5px 12px 2px; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.5; font-weight: 600; }
    #ctxMenu .mi { display: flex; align-items: center; gap: 6px; }
    #ctxMenu .mi .tick { width: 12px; flex-shrink: 0; color: var(--vscode-focusBorder); }
    #ctxMenu .mi .milbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #ctxMenu .mi .midetail { opacity: 0.5; font-size: 0.85em; flex-shrink: 0; }

    /* ---- chat column ---- */
    #chatCol { order: 3; flex: 1; display: flex; flex-direction: column; min-width: 0; }
    #chatHeader {
        display: flex; align-items: center; gap: 8px; padding: 4px 10px;
        border-bottom: 1px solid var(--vscode-panel-border, transparent);
        min-height: 26px;
    }
    #chatTitle { flex: 1; opacity: 0.75; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #listToggle { display: none; }
    #root.narrow #listToggle { display: inline-flex; }
    #log { flex: 1; overflow-y: auto; padding: 16px 16px 6px 16px; user-select: text; cursor: text; }
    .msg { margin: 0 0 18px 0; word-break: break-word; line-height: 1.6; user-select: text; -webkit-user-select: text; }
    .msg.plain { white-space: pre-wrap; }
    .role { font-size: 0.78em; opacity: 0.7; margin-bottom: 5px; display: flex; align-items: center; gap: 6px; font-weight: 600; }
    .role .avatar {
        width: 19px; height: 19px; border-radius: 5px; flex-shrink: 0;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--vscode-chat-avatarBackground, var(--vscode-badge-background, rgba(128,128,128,0.2)));
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
        border: 1px solid var(--vscode-chat-requestBorder, rgba(255,255,255,0.08));
    }
    .role .avatar svg { width: 12px; height: 12px; }
    /* user turns: right-aligned bubble */
    .msg.user { display: flex; flex-direction: column; align-items: flex-end; }
    .msg.user .role { opacity: 0.5; }
    /* user bubble: the native chat tone (chat.requestBackground — a blue in
       most themes); falls back to input-background on themes that leave it as
       a translucent editor bg that would disappear over our body. */
    .ubody {
        background: var(--vscode-chat-requestBackground, var(--vscode-input-background, rgba(255,255,255,0.07)));
        border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, rgba(255,255,255,0.12)));
        border-radius: 12px 12px 3px 12px; padding: 9px 13px; white-space: pre-wrap;
        max-width: 80%; text-align: left;
    }
    .ubody .chips { margin-top: 6px; }
    /* assistant turns: full width, no bubble */
    .msg.assistant { padding: 0 2px; }
    .msgTools { margin-top: 4px; height: 20px; }
    .msgCopy {
        background: none; border: none; cursor: pointer; padding: 2px 4px; border-radius: 4px;
        color: var(--vscode-icon-foreground, var(--vscode-foreground)); opacity: 0; transition: opacity 150ms ease, background-color 150ms ease;
    }
    .msg.assistant:hover .msgCopy { opacity: 0.6; }
    .msgCopy:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .msgCopy.done { opacity: 1 !important; color: var(--vscode-charts-green, #89d185); }
    .msgCopy svg { width: 13px; height: 13px; }
    /* markdown content */
    .md p { margin: 0 0 8px 0; }
    .md p:last-child { margin-bottom: 0; }
    .md ul, .md ol { margin: 4px 0 8px 0; padding-left: 20px; }
    .md li { margin: 2px 0; }
    .md h1, .md h2, .md h3 { margin: 10px 0 6px 0; line-height: 1.3; }
    .md h1 { font-size: 1.25em; } .md h2 { font-size: 1.15em; } .md h3 { font-size: 1.05em; }
    .md a { color: var(--vscode-textLink-foreground); }
    .md code.inline {
        font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em;
        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.17));
        padding: 1px 5px; border-radius: 4px;
    }
    .md strong { font-weight: 600; }
    .codeblock { margin: 8px 0; border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3)); border-radius: 6px; overflow: hidden; }
    .codeblock .cbhead {
        display: flex; align-items: center; justify-content: space-between;
        padding: 3px 8px; font-size: 0.78em; opacity: 0.8;
        background: var(--vscode-editorWidget-background, rgba(128,128,128,0.12));
        border-bottom: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    }
    .codeblock .cbcopy { background: none; border: none; cursor: pointer; color: inherit; opacity: 0.7; font-size: 0.95em; padding: 2px 6px; border-radius: 4px; }
    .codeblock .cbcopy:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .codeblock pre { margin: 0; padding: 8px 10px; overflow-x: auto; }
    .codeblock code {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 0.9em); white-space: pre;
    }
    .tool { opacity: 0.6; font-size: 0.9em; padding-left: 4px; font-family: var(--vscode-editor-font-family, monospace); }
    .error { color: var(--vscode-errorForeground); }
    .meta { opacity: 0.5; font-size: 0.85em; text-align: center; margin: 8px 0; }

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
    #chips:empty { display: none; }
    .chip {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 0.85em; padding: 1px 6px;
        border: 1px solid var(--vscode-input-border, #454545);
        border-radius: 4px;
        background: var(--vscode-badge-background, rgba(128,128,128,0.15));
        color: var(--vscode-badge-foreground, inherit);
        max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .chip .chipIcon { width: 11px; height: 11px; opacity: 0.7; flex-shrink: 0; }
    .chip.activeChip { border-color: var(--vscode-focusBorder); }
    .chip .x { cursor: pointer; opacity: 0.7; }
    .chip .x:hover { opacity: 1; }
    #addContext svg { width: 15px; height: 15px; }
    #input {
        border: none; outline: none; resize: none;
        background: transparent; color: var(--vscode-input-foreground);
        font-family: inherit; font-size: inherit; line-height: 1.5;
        padding: 9px 11px 5px 11px; min-height: 40px; max-height: 200px;
    }
    #input::placeholder { color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.7)); }
    /* toolbar: pickers grouped left, send pinned right, uniform controls */
    #toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 6px 6px 8px; }
    #toolbar .grow { flex: 1; }
    /* one consistent control style for all dropdowns (.ctl) */
    .ctl {
        height: 24px; box-sizing: border-box;
        background: transparent; color: var(--vscode-descriptionForeground);
        border: 1px solid transparent; border-radius: 5px;
        cursor: pointer; font-family: inherit; font-size: 0.85em; padding: 0 6px;
        transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
        max-width: 180px;
    }
    .ctl:hover:not(:disabled) { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .ctl:disabled { cursor: default; opacity: 0.7; }
    .menubtn { display: inline-flex; align-items: center; gap: 3px; }
    .menubtn .lbl { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .menubtn svg { width: 11px; height: 11px; opacity: 0.7; flex-shrink: 0; }
    #status { opacity: 0.55; font-size: 0.82em; padding: 0 6px; white-space: nowrap; }
    .iconBtn {
        background: none; border: none; cursor: pointer; padding: 3px 5px;
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
        border-radius: 4px; display: inline-flex; align-items: center;
        transition: background-color 150ms ease, color 150ms ease;
    }
    .iconBtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    /* Send = primary filled split button (send + mode caret) */
    #sendGroup { display: inline-flex; height: 26px; border-radius: 5px; overflow: hidden; }
    #sendGroup button {
        border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        transition: background-color 150ms ease, opacity 150ms ease;
    }
    #sendGroup button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
    #send { padding: 0 9px; }
    #sendCaret { padding: 0 4px; border-left: 1px solid color-mix(in srgb, var(--vscode-button-foreground) 25%, transparent); }
    #send svg { width: 15px; height: 15px; }
    #sendCaret svg { width: 12px; height: 12px; }
    #sendGroup button:disabled { opacity: 0.4; cursor: default; }

    /* ---- footer status bar ---- */
    #statusbar {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        padding: 3px 12px 6px 12px; font-size: 0.78em; opacity: 0.6;
        border-top: 1px solid var(--vscode-panel-border, transparent);
    }
    #statusbar .seg { display: inline-flex; align-items: center; gap: 4px; }
    #statusbar svg { width: 12px; height: 12px; }
    #statusbar:empty { display: none; }

    /* ---- sessions pane resizer ---- */
    #resizer {
        order: 2; flex: 0 0 5px; cursor: col-resize; position: relative; z-index: 5;
        background: transparent; transition: background-color 150ms ease;
    }
    #resizer::after { content: ""; position: absolute; inset: 0 2px; background: var(--vscode-panel-border, #333); opacity: 0.4; }
    #resizer:hover::after, #resizer.dragging::after { background: var(--vscode-focusBorder); opacity: 1; }
    #root.side-right #resizer { order: 2; }
    #root.narrow #resizer, #root.chat-only #resizer { display: none; }
</style>
</head>
<body>
<div id="root">
    <div id="progress"></div>
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
    <div id="resizer" title="Drag to resize"></div>
    <main id="chatCol">
        <div id="chatHeader">
            <button id="listToggle" class="iconBtn" title="Sessions">☰</button>
            <span id="chatTitle"></span>
        </div>
        <div id="log"></div>
        <div id="loadingState"><span class="spinner"></span><span id="loadingText">Loading session…</span></div>
        <div id="composer">
            <div id="slash"></div>
            <div id="chips"></div>
            <textarea id="input" placeholder="Ask the agent…  (Enter sends · Shift+Enter newline)"></textarea>
            <div id="toolbar">
                <button id="addContext" class="iconBtn" title="Attach files">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.5.5 0 0 1 .5.5V7.5h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6V1.5A.5.5 0 0 1 8 1Z"/></svg>
                </button>
                <button id="configBtn" class="iconBtn" title="Tools & configuration">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3a2 2 0 0 1 3.9-.5H14v1H7.9A2 2 0 0 1 4 3Zm-2 .5h1.2a2 2 0 0 0 0-1H2v1Zm6 4.5a2 2 0 0 1 3.9-.5H14v1h-2.1A2 2 0 0 1 8 8Zm-6 .5h4.2a2 2 0 0 0 0-1H2v1Zm2 4.5a2 2 0 0 1 3.9-.5H14v1H7.9A2 2 0 0 1 4 13Zm-2 .5h1.2a2 2 0 0 0 0-1H2v1Z"/></svg>
                </button>
                <button id="modelPicker" class="ctl menubtn" title="Model (locked after first message)"><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                <button id="reasoningPicker" class="ctl menubtn" title="Reasoning effort (locked after first message)"><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                <span id="status"></span>
                <span class="grow"></span>
                <select id="sendMode" style="display:none">
                    <option value="send">Send</option>
                    <option value="queue">Queue</option>
                    <option value="steer">Steer</option>
                </select>
                <div id="sendGroup">
                    <button id="send" title="Send (Enter)"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.2 2.8 3 8 1.2 13.2a.5.5 0 0 0 .7.6l13-5.5a.5.5 0 0 0 0-.9l-13-5.5a.5.5 0 0 0-.7.6Z"/></svg></button>
                    <button id="sendCaret" title="Send mode"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                </div>
            </div>
        </div>
        <footer id="statusbar"></footer>
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
    let activeFile = null;  // active editor path, offered as removable context
    let activeFileDismissed = false;
    let currentBackend = "";
    let activeModel = "";
    let activeSessionId = "";
    let busy = false;
    let queued = 0;
    let loading = false;
    let sessions = [];
    let showArchived = false;

    document.getElementById("newSessionBtn").addEventListener("click", () => { setLoading(true, "Starting…"); vscode.postMessage({ type: "new-session" }); });
    document.getElementById("archToggle").addEventListener("click", () => { showArchived = !showArchived; renderSessions(); });

    // Persisted UI state (send mode + sessions pane width).
    const saved = (vscode.getState && vscode.getState()) || {};
    function saveState(patch) { vscode.setState && vscode.setState(Object.assign({}, saved, patch)); Object.assign(saved, patch); }
    if (saved.sendMode) { sendMode.value = saved.sendMode; }
    sendMode.addEventListener("change", () => saveState({ sendMode: sendMode.value }));

    // Split send-button: caret opens a small menu to choose Send/Queue/Steer.
    const sendCaret = document.getElementById("sendCaret");
    const MODE_LABELS = { send: "Send", queue: "Queue", steer: "Steer" };
    const MODE_DESC = {
        send: "Send now; queued while a turn runs",
        queue: "Always wait for the current turn (FIFO)",
        steer: "Interrupt the running turn and send now",
    };
    function updateSendTitle() { sendBtn.title = MODE_LABELS[sendMode.value] + " (Enter) — " + MODE_DESC[sendMode.value]; }
    sendCaret.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ctxMenu.textContent = "";
        for (const mode of ["send", "queue", "steer"]) {
            const mi = document.createElement("div"); mi.className = "mi";
            mi.textContent = (sendMode.value === mode ? "✓ " : "    ") + MODE_LABELS[mode];
            mi.title = MODE_DESC[mode];
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
        renderRows("");
        ctxMenu.appendChild(list);

        ctxMenu.style.display = "block";
        const r = anchorEl.getBoundingClientRect();
        const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
        ctxMenu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";
        ctxMenu.style.top = Math.max(4, r.top - h - 4) + "px";
    }
    let modelValue = "", modelList = [], reasoningValue = "default", reasoningList = [];
    let reasoningDefault = "", modelDefault = "";
    const modelLbl = modelPicker.querySelector(".lbl");
    const reasoningLbl = reasoningPicker.querySelector(".lbl");
    // "default" means: don't override — the backend uses its own default. When
    // a default is configured in settings, show it in parens so it's not blind.
    function defLabel(configured) { return configured && configured !== "default" ? "default (" + configured + ")" : "default"; }
    function setModelLabel() { modelLbl.textContent = modelValue && modelValue !== "default" ? modelValue : defLabel(modelDefault); }
    function setReasoningLabel() { reasoningLbl.textContent = reasoningValue && reasoningValue !== "default" ? "effort: " + reasoningValue : defLabel(reasoningDefault); }
    modelPicker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (modelPicker.disabled || !modelList.length) return;
        openChoiceMenu(modelPicker, modelList.map((m) => ({ value: m, label: m === "default" ? defLabel(modelDefault) : m })), modelValue, (v) => { modelValue = v; setModelLabel(); });
    });
    reasoningPicker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (reasoningPicker.disabled || !reasoningList.length) return;
        openChoiceMenu(reasoningPicker, reasoningList.map((r) => ({ value: r, label: r === "default" ? defLabel(reasoningDefault) : r })), reasoningValue, (v) => { reasoningValue = v; setReasoningLabel(); });
    });

    // ---- tools & configuration menu (sliders) ----
    const configBtn = document.getElementById("configBtn");
    let permissionModes = [], permissionValue = "default";
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
                const mi = document.createElement("div"); mi.className = "mi";
                const tick = document.createElement("span"); tick.className = "tick"; tick.textContent = p === permissionValue ? "✓" : "";
                const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = p;
                mi.appendChild(tick); mi.appendChild(lbl); mi.title = PERM_DESC[p] || "";
                mi.addEventListener("click", () => { permissionValue = p; });
                list.appendChild(mi);
            }
            const sep = document.createElement("div"); sep.className = "sep"; list.appendChild(sep);
        }
        const open = document.createElement("div"); open.className = "mi";
        const t = document.createElement("span"); t.className = "tick"; const l = document.createElement("span"); l.className = "milbl"; l.textContent = "Open Settings…";
        open.appendChild(t); open.appendChild(l);
        open.addEventListener("click", () => vscode.postMessage({ type: "open-settings" }));
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
    function autoScroll(stick) { if (stick) log.scrollTop = log.scrollHeight; }

    function append(cls, text) {
        const stick = nearBottom();
        const el = document.createElement("div");
        el.className = "msg plain " + cls;
        el.textContent = text;
        log.appendChild(el);
        autoScroll(stick);
        return el;
    }

    // A chat message with a small role label (user/assistant); assistant text
    // is rendered as markdown.
    const BACKEND_NAMES = { claude: "Claude", codex: "Codex", copilot: "Copilot" };
    function message(role, text) {
        const stick = nearBottom();
        const wrap = document.createElement("div");
        wrap.className = "msg " + role;
        const label = document.createElement("div");
        label.className = "role " + role;
        if (role === "assistant") {
            const av = document.createElement("span"); av.className = "avatar"; av.appendChild(svgIcon("robot"));
            const name = document.createElement("span"); name.textContent = BACKEND_NAMES[currentBackend] || "Agent";
            label.appendChild(av); label.appendChild(name);
        } else {
            const name = document.createElement("span"); name.textContent = "You";
            label.appendChild(name);
        }
        wrap.appendChild(label);
        const body = document.createElement("div");
        if (role === "assistant") { body.className = "md"; renderMarkdown(body, text); }
        else { body.className = "ubody"; body.textContent = text; }
        wrap.appendChild(body);
        if (role === "assistant") {
            const tools = document.createElement("div"); tools.className = "msgTools";
            const cp = document.createElement("button"); cp.className = "msgCopy"; cp.title = "Copy message";
            cp.appendChild(svgIcon("copy"));
            cp.addEventListener("click", () => {
                navigator.clipboard && navigator.clipboard.writeText(text);
                cp.classList.add("done"); setTimeout(() => cp.classList.remove("done"), 1000);
            });
            tools.appendChild(cp);
            wrap.appendChild(tools);
        }
        log.appendChild(wrap);
        autoScroll(stick);
        return wrap;
    }

    // ---- minimal, safe markdown → DOM (no innerHTML of untrusted text) ----
    function renderMarkdown(container, src) {
        const lines = String(src).split("\\n");
        let i = 0; let list = null;
        const flushList = () => { list = null; };
        while (i < lines.length) {
            const line = lines[i];
            const fence = line.match(/^\`\`\`(\\w*)\\s*$/);
            if (fence) {
                flushList();
                const lang = fence[1] || "";
                const buf = [];
                i++;
                while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
                i++; // skip closing fence
                container.appendChild(codeBlock(lang, buf.join("\\n")));
                continue;
            }
            const h = line.match(/^(#{1,3})\\s+(.*)$/);
            if (h) { flushList(); const el = document.createElement("h" + h[1].length); inline(el, h[2]); container.appendChild(el); i++; continue; }
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
            while (i < lines.length && lines[i].trim() && !/^(#{1,3}\\s|\\s*[-*]\\s|\\s*\\d+\\.\\s|\`\`\`)/.test(lines[i])) { para.push(lines[i]); i++; }
            const p = document.createElement("p"); inline(p, para.join(" ")); container.appendChild(p);
        }
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
        status.textContent = busy ? ("thinking..." + q) : (activeModel ? "model: " + activeModel : "");
        syncProgress();
    }

    const progress = document.getElementById("progress");
    // Top progress bar reflects any pending work (switching or a running turn).
    function syncProgress() { progress.classList.toggle("on", loading || busy); }
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
        plus: "M8 1.5a.5.5 0 0 1 .5.5V7.5h5.5a.5.5 0 0 1 0 1H8.5V14a.5.5 0 0 1-1 0V8.5H2a.5.5 0 0 1 0-1h5.5V2a.5.5 0 0 1 .5-.5Z",
        chevron: "M4 6l4 4 4-4H4Z",
    };
    function svgIcon(name) {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("fill", "currentColor");
        const p = document.createElementNS(ns, "path"); p.setAttribute("d", ICONS[name] || "");
        svg.appendChild(p);
        return svg;
    }

    // Per-session actions, shown as hover icons on the right and in the
    // right-click menu. Each posts a session-action the extension handles.
    function actionsFor(s) {
        const list = [
            { id: "open", icon: "terminal", label: "Resume in terminal" },
            { id: "rename", icon: "rename", label: "Rename" },
            { id: "watch", icon: "eye", label: "Watch live (read-only)" },
        ];
        list.push(s.archived
            ? { id: "unarchive", icon: "unarchive", label: "Unarchive" }
            : { id: "archive", icon: "archive", label: "Archive" });
        list.push({ id: "delete", icon: "trash", label: "Delete permanently", danger: true });
        return list;
    }

    function runAction(s, action) {
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

    function renderSessions() {
        sessionsList.textContent = "";
        const visible = sessions.filter((s) => !s.archived || showArchived);
        let lastBucket = null;
        for (const s of visible) {
            const bk = bucket(s.updatedAt);
            if (bk !== lastBucket) {
                lastBucket = bk;
                const count = visible.filter((x) => bucket(x.updatedAt) === bk).length;
                const gh = document.createElement("div"); gh.className = "groupHeader";
                const gl = document.createElement("span"); gl.textContent = bk;
                const gc = document.createElement("span"); gc.className = "gcount"; gc.textContent = String(count);
                gh.appendChild(gl); gh.appendChild(gc);
                sessionsList.appendChild(gh);
            }
            const el = document.createElement("div");
            el.className = "sessionItem" + (s.sessionId === activeSessionId ? " active" : "") + (s.archived ? " archived" : "");

            // Live status indicator: spinner = working, green dot = idle/live.
            const statusDot = document.createElement("div");
            statusDot.className = "statusDot";
            if (s.status === "working") {
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
            if (s.archived) { const ar = svgIcon("archive"); ar.classList.add("ttlIcon"); ttl.appendChild(ar); }
            ttl.appendChild(document.createTextNode(s.title));
            ttl.title = s.title + "\\n" + s.sessionId;
            const sub = document.createElement("span");
            sub.className = "sub";
            const statusText = s.status === "working" ? "working… · " : (s.status === "idle" ? "live · " : "");
            sub.textContent = statusText + s.backend + (s.updatedAt ? " · " + relTime(s.updatedAt) : "");
            sub.title = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
            body.appendChild(ttl);
            body.appendChild(sub);
            body.addEventListener("click", () => {
                root.classList.remove("listOpen");
                activeSessionId = s.sessionId; renderSessions();
                setLoading(true, "Loading session…");
                vscode.postMessage({ type: "open-session", sessionId: s.sessionId, backend: s.backend });
            });

            const acts = document.createElement("div");
            acts.className = "acts";
            for (const a of actionsFor(s)) {
                const b = document.createElement("button");
                if (a.danger) b.classList.add("danger");
                b.appendChild(svgIcon(a.icon));
                b.title = a.label;
                b.addEventListener("click", (ev) => { ev.stopPropagation(); runAction(s, a.id); });
                acts.appendChild(b);
            }

            el.appendChild(statusDot);
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
    document.addEventListener("scroll", hideCtx, true);

    function makeChip(label, fullPath, onRemove, active) {
        const chip = document.createElement("span");
        chip.className = "chip" + (active ? " activeChip" : "");
        chip.title = fullPath;
        const ic = svgIcon("file"); ic.classList.add("chipIcon"); chip.appendChild(ic);
        chip.appendChild(document.createTextNode(label));
        const x = document.createElement("span"); x.className = "x"; x.textContent = "✕";
        x.addEventListener("click", onRemove);
        chip.appendChild(x);
        return chip;
    }
    function renderChips() {
        chips.querySelectorAll(".chip").forEach((el) => el.remove());
        // Active editor file as a removable context chip (like the native chat).
        if (activeFile && !activeFileDismissed) {
            const base = activeFile.split("/").filter(Boolean).pop() || activeFile;
            chips.appendChild(makeChip(base, activeFile, () => { activeFileDismissed = true; renderChips(); }, true));
        }
        for (const file of attachments) {
            chips.appendChild(makeChip(file.name, file.path, () => {
                attachments = attachments.filter((a) => a.path !== file.path);
                renderChips();
            }, false));
        }
    }

    // Footer status bar: cwd · backend · permission/mode (like the native bar).
    const statusbar = document.getElementById("statusbar");
    function renderStatusbar(data) {
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
    }

    function send() {
        const text = input.value.trim();
        if (!text) return;
        // While a turn runs, only queue/steer may submit; plain send waits too
        // (the extension queues it), so allow submitting in every mode.
        input.value = "";
        modelPicker.disabled = true;
        reasoningPicker.disabled = true;
        const atts = attachments.map((a) => a.path);
        if (activeFile && !activeFileDismissed) atts.unshift(activeFile);
        vscode.postMessage({
            type: "send",
            text,
            attachments: atts,
            model: modelValue,
            reasoning: reasoningValue,
            permission: permissionValue,
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
                currentBackend = data.backend || "";
                chatTitle.textContent = (data.title ? data.title + " · " : "") + data.backend;
                modelDefault = data.modelDefault || "";
                reasoningDefault = data.reasoningDefault || "";
                modelList = data.models || [];
                modelValue = modelList[0] || "";
                modelPicker.disabled = false;
                modelPicker.style.display = modelList.length ? "" : "none";
                setModelLabel();
                reasoningList = data.reasoningLevels || [];
                reasoningValue = reasoningList[0] || "default";
                reasoningPicker.disabled = false;
                reasoningPicker.style.display = reasoningList.length ? "" : "none";
                setReasoningLabel();
                permissionModes = data.permissionModes || [];
                permissionValue = data.permission || "default";
                configBtn.style.display = (permissionModes.length || true) ? "" : "none";
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
                activeFile = data.activeFile || null; activeFileDismissed = false; renderChips();
                setLoading(false);   // session resolved — reveal the conversation
                break;
            }
            case "active-file": {
                // Editor switched — offer the new file as context again.
                activeFile = data.path || null; activeFileDismissed = false; renderChips();
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
                if (m.role === "user") message("user", m.text);
                else if (m.role === "tool") append("tool", m.text);
                else message("assistant", m.text);
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
                    if (m.role === "user") message("user", m.text);
                    else if (m.role === "tool") append("tool", m.text);
                    else message("assistant", m.text);
                }
                append("meta", data.messages.length ? "— end of stored transcript —" : "(empty transcript)");
                break;
            }
            case "user": {
                const el = message("user", data.text);
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
                if (ev.kind === "text") message("assistant", ev.text);
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
