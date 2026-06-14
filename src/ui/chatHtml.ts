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
    /* scrollbars: match the native VS Code overlay slider — thin, no arrow
       buttons, transparent track, slider inset via a transparent border. */
    ::-webkit-scrollbar { width: 14px; height: 14px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-button { display: none; height: 0; width: 0; }
    ::-webkit-scrollbar-corner { background: transparent; }
    ::-webkit-scrollbar-thumb {
        background-color: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4));
        border: 4px solid transparent; background-clip: padding-box;
    }
    ::-webkit-scrollbar-thumb:hover {
        background-color: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.7));
    }
    ::-webkit-scrollbar-thumb:active {
        background-color: var(--vscode-scrollbarSlider-activeBackground, rgba(191,191,191,0.4));
    }
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
    #log {
        flex: 1; overflow-y: auto; padding: 16px 16px 6px 16px; user-select: text; cursor: text;
        font-size: 13.5px; line-height: 1.65;
    }
    .msg { margin: 0 0 18px 0; word-break: break-word; line-height: 1.65; user-select: text; -webkit-user-select: text; }
    .msg.plain { white-space: pre-wrap; }
    /* Clear separation between message blocks (not between tool rows): a hairline
       rule + breathing room above each user/assistant turn marks where one ends
       and the next begins. */
    /* Inter-turn gap lives in margin (outside the box) so a hover highlight hugs
       the content; a modest padding spaces content below the line + sideways. */
    .msg.user, .msg.assistant {
        margin-top: 18px; padding: 14px 8px 0 8px;
        border-top: 1px solid var(--vscode-panel-border, color-mix(in srgb, var(--vscode-foreground) 14%, transparent));
    }
    #log > .msg.user:first-child, #log > .msg.assistant:first-child { margin-top: 0; padding-top: 0; border-top: none; }
    .role { font-size: 0.82em; opacity: 1; margin-bottom: 7px; display: flex; align-items: center; gap: 6px; font-weight: 600; letter-spacing: 0.02em; color: var(--vscode-foreground); }
    .role .msgTime { font-weight: 400; opacity: 0; font-size: 0.92em; color: var(--vscode-descriptionForeground); transition: opacity 150ms ease; }
    .msg:hover .role .msgTime { opacity: 0.7; }
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
    .msg.user .role { opacity: 0.75; }
    /* user bubble: a subtle blue tint derived from the theme accent
       (focusBorder), mirroring the native chat — many themes leave
       chat.requestBackground as a near-invisible translucent editor bg, so we
       mix the accent ourselves to guarantee the blue tone in every theme. */
    .ubody {
        background: color-mix(in srgb, var(--vscode-focusBorder, #0078d4) 16%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #0078d4) 32%, transparent);
        border-radius: 12px 12px 3px 12px; padding: 10px 14px; white-space: pre-wrap;
        max-width: 82%; text-align: left; line-height: 1.6;
    }
    .ubody .chips { margin-top: 6px; }
    /* assistant turns: full width, no bubble (padding from the combined rule). */
    .msg.assistant { position: relative; }
    /* copy: a hover-only floating action in the corner, reserves no space */
    .msgTools { position: absolute; top: 12px; right: 6px; margin: 0; z-index: 1; }
    /* hovering copy highlights exactly the message it will copy */
    .msg.assistant:has(.msgCopy:hover) {
        background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
        border-radius: 6px; box-shadow: 0 0 0 1px var(--vscode-focusBorder, rgba(128,128,128,0.4)) inset;
    }
    .msgCopy {
        background: var(--vscode-editor-background, transparent); border: none; cursor: pointer; padding: 2px 4px; border-radius: 4px;
        color: var(--vscode-icon-foreground, var(--vscode-foreground)); opacity: 0; transition: opacity 150ms ease, background-color 150ms ease;
    }
    .msg.assistant:hover .msgCopy { opacity: 0.6; }
    .msgCopy:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .msgCopy.done { opacity: 1 !important; color: var(--vscode-charts-green, #89d185); }
    .msgCopy svg { width: 13px; height: 13px; }
    /* markdown content */
    .md { line-height: 1.65; }
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md p { margin: 0 0 10px 0; }
    .md ul, .md ol { margin: 6px 0 10px 0; padding-left: 22px; }
    .md li { margin: 3px 0; }
    .md li::marker { color: var(--vscode-descriptionForeground); }
    .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
        margin: 16px 0 8px 0; line-height: 1.3; font-weight: 600; color: var(--vscode-foreground);
    }
    .md h1 { font-size: 1.4em; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
    .md h2 { font-size: 1.22em; padding-bottom: 3px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
    .md h3 { font-size: 1.1em; }
    .md h4 { font-size: 1em; opacity: 0.95; }
    .md h5, .md h6 { font-size: 0.92em; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.03em; }
    .md a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .md a:hover { text-decoration: underline; }
    .md hr { border: none; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); margin: 14px 0; }
    .md blockquote {
        margin: 8px 0; padding: 2px 0 2px 12px;
        border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
        background: var(--vscode-textBlockQuote-background, transparent);
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .md blockquote p { margin: 2px 0; }
    .md code.inline {
        font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
        color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
        background: var(--vscode-textPreformat-background, var(--vscode-textCodeBlock-background, rgba(128,128,128,0.17)));
        padding: 1px 5px; border-radius: 4px;
        border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    }
    .md strong { font-weight: 700; color: var(--vscode-foreground); }
    .md em { font-style: italic; }
    .codeblock { margin: 8px 0; border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3)); border-radius: 6px; overflow: hidden; }
    .codeblock .cbhead {
        display: flex; align-items: center; justify-content: space-between;
        padding: 3px 8px; font-size: 0.78em; opacity: 0.8;
        background: var(--vscode-editorWidget-background, rgba(128,128,128,0.12));
        border-bottom: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    }
    .codeblock .cbcopy { background: none; border: none; cursor: pointer; color: inherit; opacity: 0.7; font-size: 0.95em; padding: 2px 6px; border-radius: 4px; }
    .codeblock .cbcopy:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .codeblock pre {
        margin: 0; padding: 8px 10px; overflow-x: auto;
        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    }
    .codeblock code {
        display: block; background: none; border: none; padding: 0;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 0.9em); white-space: pre;
        color: var(--vscode-editor-foreground, var(--vscode-foreground));
    }
    .tool { opacity: 0.6; font-size: 0.9em; padding-left: 4px; font-family: var(--vscode-editor-font-family, monospace); }
    /* tool invocation row — native-chat look: icon + verb + muted target */
    .toolrow {
        display: flex; align-items: center; gap: 7px;
        padding: 2px 8px; margin: 1px 0; border-radius: 4px;
        font-size: 0.9em; line-height: 1.5;
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .toolrow:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .toolrow.expandable { cursor: pointer; }
    .toolrow .tIcon { display: inline-flex; flex-shrink: 0; opacity: 0.8; }
    .toolrow .tIcon svg { width: 14px; height: 14px; }
    .toolrow .tVerb { color: var(--vscode-foreground); opacity: 0.85; flex-shrink: 0; }
    .toolrow .tTarget {
        flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em;
        opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .toolrow .tTarget.tLink { cursor: pointer; color: var(--vscode-textLink-foreground); opacity: 0.85; }
    .toolrow .tTarget.tLink:hover { text-decoration: underline; opacity: 1; }
    .toolrow .tChev { margin-left: auto; flex-shrink: 0; opacity: 0.55; display: inline-flex; transition: transform 150ms ease; }
    .toolrow .tChev svg { width: 12px; height: 12px; }
    .toolwrap { margin: 1px 0; }
    .toolwrap.open .toolrow .tChev { transform: rotate(180deg); }
    /* tool activity group — a timeline rail tying a turn's tool calls together */
    .toolgroup { margin: 10px 0; }
    .toolgroup .tghead {
        display: flex; align-items: center; gap: 6px; cursor: pointer;
        font-size: 0.76em; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
        opacity: 0.6; padding: 1px 2px 5px;
    }
    .toolgroup .tghead:hover { opacity: 0.85; }
    .toolgroup .tghead .tgchev { width: 11px; height: 11px; transition: transform 150ms ease; }
    .toolgroup.collapsed .tghead .tgchev { transform: rotate(-90deg); }
    .toolgroup .tgbody {
        border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,0.22));
        margin-left: 6px; padding-left: 9px;
    }
    .toolgroup.collapsed .tgbody { display: none; }
    .toolgroup .tgbody .toolwrap { margin: 0; }
    .toolgroup .tgbody .toolrow { padding: 3px 8px; }
    .toolbody { display: none; margin: 4px 0 8px 26px; }
    .toolwrap.open .toolbody { display: block; }
    .toolsec { margin: 6px 0; }
    .toolsec .tlabel { font-size: 0.8em; font-weight: 600; opacity: 0.7; margin-bottom: 3px; }
    .toolsec pre {
        margin: 0; padding: 8px 10px; max-height: 320px; overflow: auto;
        border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3)); border-radius: 6px;
        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
        font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em;
        white-space: pre-wrap; word-break: break-word;
    }
    /* diff counts on edit rows */
    .tDiff { flex-shrink: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; margin-left: 8px; }
    .tAdd { color: var(--vscode-gitDecoration-addedResourceForeground, #4ec94e); }
    .tDel { color: var(--vscode-gitDecoration-deletedResourceForeground, #d16969); margin-left: 5px; }
    .tSpacer { flex: 1; min-width: 0; }
    /* queued messages — editable until dispatched */
    #queued { display: none; border-top: 1px solid var(--vscode-panel-border, transparent); padding: 6px 10px 2px; }
    #queued.has { display: block; }
    #queued .qhead { font-size: 0.72em; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.55; margin: 0 2px 5px; }
    .qitem {
        display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; padding: 7px 9px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--vscode-focusBorder, #0078d4) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #0078d4) 24%, transparent);
    }
    .qitem .qmain { flex: 1; min-width: 0; }
    .qitem .qtext {
        white-space: pre-wrap; word-break: break-word; font-size: 0.9em; line-height: 1.5;
        max-height: 96px; overflow: hidden; cursor: text;
    }
    .qitem .qatts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
    .qitem .qatt {
        display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px 1px 4px; border-radius: 4px;
        font-size: 0.8em; background: var(--vscode-badge-background, rgba(128,128,128,0.25));
        color: var(--vscode-badge-foreground, var(--vscode-foreground)); max-width: 180px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .qitem .qatt .qattIcon { width: 11px; height: 11px; flex-shrink: 0; opacity: 0.8; }
    .qitem .qacts { display: inline-flex; gap: 2px; flex-shrink: 0; }
    .qitem .qbtn {
        background: none; border: none; cursor: pointer; padding: 3px; border-radius: 4px;
        color: var(--vscode-icon-foreground, var(--vscode-foreground)); display: inline-flex; opacity: 0.75;
    }
    .qitem .qbtn svg { width: 13px; height: 13px; }
    .qitem .qbtn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    /* plan / todo — pinned above the edited-files set */
    #plan { display: none; border-top: 1px solid var(--vscode-panel-border, transparent); }
    #plan.has { display: block; }
    #plan .plhead {
        display: flex; align-items: center; gap: 6px; padding: 4px 12px; cursor: pointer;
        font-size: 0.78em; font-weight: 600; opacity: 0.85;
    }
    #plan .plhead .pltitle { flex: 1; }
    #plan .plhead .plcount { opacity: 0.65; font-weight: 400; }
    #plan .plhead svg { width: 12px; height: 12px; transition: transform 150ms ease; }
    #plan.collapsed .plhead svg.plchev { transform: rotate(-90deg); }
    #plan .pllist { max-height: 160px; overflow-y: auto; padding: 0 12px 6px 12px; }
    #plan.collapsed .pllist { display: none; }
    .todoitem { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; line-height: 1.5; font-size: 0.9em; }
    .todoitem .tmark { flex-shrink: 0; width: 15px; height: 15px; margin-top: 1px; display: inline-flex; }
    .todoitem .tmark svg { width: 15px; height: 15px; }
    .todoitem.done .tcontent { opacity: 0.5; text-decoration: line-through; }
    .todoitem.active .tcontent { color: var(--vscode-foreground); font-weight: 600; }
    .todoitem.active .tmark { color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); }
    .todoitem.done .tmark { color: var(--vscode-gitDecoration-addedResourceForeground, #4ec94e); }
    .todoitem .tmark.pending { color: var(--vscode-descriptionForeground); opacity: 0.6; }
    /* changed-files working set above the composer */
    #changedFiles { display: none; border-top: 1px solid var(--vscode-panel-border, transparent); }
    #changedFiles.has { display: block; }
    #changedFiles .cfhead {
        display: flex; align-items: center; gap: 6px; padding: 4px 12px; cursor: pointer;
        font-size: 0.78em; font-weight: 600; opacity: 0.75;
    }
    #changedFiles .cfhead .cftitle { flex: 1; }
    #changedFiles .cfhead svg { width: 12px; height: 12px; transition: transform 150ms ease; }
    #changedFiles.collapsed .cfhead svg.cfchev { transform: rotate(-90deg); }
    #changedFiles .cflist { max-height: 132px; overflow-y: auto; padding: 0 8px 6px 8px; }
    #changedFiles.collapsed .cflist { display: none; }
    .cfitem {
        display: flex; align-items: center; gap: 7px; padding: 3px 6px; border-radius: 4px;
        cursor: pointer; font-size: 0.85em;
    }
    .cfitem:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
    .cfitem .cficon { flex-shrink: 0; opacity: 0.75; display: inline-flex; }
    .cfitem .cficon svg { width: 13px; height: 13px; }
    .cfitem .cfname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cfitem .cfdir { opacity: 0.5; font-size: 0.9em; }
    .cfitem .cfdiff { flex-shrink: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; }
    .cfitem.approved .cfname { opacity: 0.55; }
    .cfitem.approved .cficon { color: var(--vscode-gitDecoration-stageModifiedResourceForeground, var(--vscode-gitDecoration-addedResourceForeground, #4ec94e)); opacity: 1; }
    .cfacts, .cfheadActs { display: inline-flex; gap: 2px; flex-shrink: 0; }
    .cfacts { opacity: 0; }
    .cfitem:hover .cfacts { opacity: 1; }
    .cfbtn {
        background: none; border: none; cursor: pointer; padding: 2px; border-radius: 4px;
        color: var(--vscode-icon-foreground, var(--vscode-foreground)); display: inline-flex; opacity: 0.8;
    }
    .cfbtn svg { width: 13px; height: 13px; }
    .cfbtn.labeled {
        gap: 4px; padding: 3px 8px; font-size: 0.9em; font-weight: 600;
        align-items: center; opacity: 1;
    }
    .cfbtn.labeled.ok {
        color: var(--vscode-gitDecoration-addedResourceForeground, #4ec94e);
        border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #4ec94e) 45%, transparent);
    }
    .cfbtn.labeled.no {
        color: var(--vscode-gitDecoration-deletedResourceForeground, #d16969);
        border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #d16969) 45%, transparent);
    }
    .cfbtn.labeled.ok:hover { background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #4ec94e) 18%, transparent); }
    .cfbtn.labeled.no:hover { background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #d16969) 18%, transparent); }
    .cfbtn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .cfbtn.ok:hover { color: var(--vscode-gitDecoration-addedResourceForeground, #4ec94e); }
    .cfbtn.no:hover { color: var(--vscode-gitDecoration-deletedResourceForeground, #d16969); }
    .error { color: var(--vscode-errorForeground); }
    .meta { opacity: 0.55; font-size: 0.82em; text-align: center; margin: 10px 0; }

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
    #send #sendIcon { display: inline-flex; }
    #sendCaret svg { width: 12px; height: 12px; }
    #ctxMenu .mi .mikbd {
        flex-shrink: 0; opacity: 0.6; font-size: 0.82em; margin-left: 10px;
        font-family: var(--vscode-editor-font-family, monospace);
    }
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
        <div id="queued"></div>
        <div id="plan"></div>
        <div id="changedFiles"></div>
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
                    <option value="queue">Queue</option>
                    <option value="steer">Steer</option>
                </select>
                <div id="sendGroup">
                    <button id="send" title="Send (Enter)"><span id="sendIcon"></span></button>
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
    let currentBackend = "", currentBackendName = "";
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
    // Each mode has its own icon and its own keyboard shortcut (like the
    // native chat): Enter sends with the selected default mode, while the
    // modifier shortcuts force a specific mode regardless of the default.
    const sendCaret = document.getElementById("sendCaret");
    const sendIcon = document.getElementById("sendIcon");
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
    function updateSendTitle() {
        // Queue/Steer only exist while a turn is running. When idle there's
        // nothing to queue behind or interrupt — it's always a plain Send, so
        // show the send icon and hide the mode caret.
        if (!busy) {
            sendIcon.innerHTML = MODE_ICONS.send;
            sendBtn.title = "Send (Enter)";
            sendCaret.style.display = "none";
            return;
        }
        sendCaret.style.display = "";
        const m = sendMode.value;
        sendIcon.innerHTML = MODE_ICONS[m];
        sendBtn.title = MODE_LABELS[m] + " (" + MODE_KBD[m] + ") — " + MODE_DESC[m];
    }
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
    let reasoningDefault = "", modelDefault = "", modelLabels = {};
    function modelLabel(id) { return (id && modelLabels[id]) || id; }
    const modelLbl = modelPicker.querySelector(".lbl");
    const reasoningLbl = reasoningPicker.querySelector(".lbl");
    // "default" means: don't override — the backend uses its own default. When
    // a default is configured in settings, show it in parens so it's not blind.
    function defLabel(configured) { return configured && configured !== "default" ? "default (" + configured + ")" : "default"; }
    function setModelLabel() { modelLbl.textContent = modelValue && modelValue !== "default" ? modelLabel(modelValue) : defLabel(modelDefault); }
    function setReasoningLabel() { reasoningLbl.textContent = reasoningValue && reasoningValue !== "default" ? "effort: " + reasoningValue : defLabel(reasoningDefault); }
    modelPicker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (modelPicker.disabled || !modelList.length) return;
        openChoiceMenu(modelPicker, modelList.map((m) => ({ value: m, label: m === "default" ? defLabel(modelDefault) : modelLabel(m) })), modelValue, (v) => { modelValue = v; setModelLabel(); });
    });
    reasoningPicker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (reasoningPicker.disabled || !reasoningList.length) return;
        openChoiceMenu(reasoningPicker, reasoningList.map((r) => ({ value: r, label: r === "default" ? defLabel(reasoningDefault) : r })), reasoningValue, (v) => { reasoningValue = v; setReasoningLabel(); });
    });

    // ---- tools & configuration menu (sliders) ----
    const configBtn = document.getElementById("configBtn");
    let permissionModes = [], permissionValue = "default", permissionDefault = "default";
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
                const lbl = document.createElement("span"); lbl.className = "milbl"; lbl.textContent = p + (p === permissionDefault ? " (default)" : "");
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
        endToolGroup();
        const el = document.createElement("div");
        el.className = "msg plain " + cls;
        el.textContent = text;
        log.appendChild(el);
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
    function message(role, text, ts) {
        const stick = nearBottom();
        endToolGroup();
        const wrap = document.createElement("div");
        wrap.className = "msg " + role;
        const label = document.createElement("div");
        label.className = "role " + role;
        if (role === "assistant") {
            const av = document.createElement("span"); av.className = "avatar"; av.appendChild(svgIcon("robot"));
            const name = document.createElement("span"); name.textContent = currentBackendName || BACKEND_NAMES[currentBackend] || "Agent";
            label.appendChild(av); label.appendChild(name);
        } else {
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
        if (role === "assistant") {
            const tools = document.createElement("div"); tools.className = "msgTools";
            const cp = document.createElement("button"); cp.className = "msgCopy"; cp.title = "Copy this reply";
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
        updateSendTitle();   // mode caret/icon depends on busy state
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
        edit: "M12.1 1.6a1.4 1.4 0 0 1 2 2L5 12.7l-2.8.8.8-2.8 9.1-9.1Zm-1 1.4L3.6 10.4l-.4 1.4 1.4-.4 7.5-7.4-1-1Z",
        search: "M6.5 1a5.5 5.5 0 0 1 4.3 8.9l3.1 3.2-.7.7-3.2-3.1A5.5 5.5 0 1 1 6.5 1Zm0 1a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z",
        globe: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM6.1 5.5h3.8a12 12 0 0 1 0 3H6.1a12 12 0 0 1 0-3ZM8 2.5c.6 0 1.4 1.3 1.8 3.5H6.2C6.6 3.8 7.4 2.5 8 2.5Zm0 11c-.6 0-1.4-1.3-1.8-3.5h3.6c-.4 2.2-1.2 3.5-1.8 3.5Zm3.2-1.3a10 10 0 0 0 .8-2.7h2a5.5 5.5 0 0 1-2.8 2.7Zm.8-3.7a14 14 0 0 0 0-3h2.1A5.5 5.5 0 0 1 13.5 8c0 .5-.1 1-.2 1.5H12Zm.9-4.5H11a10 10 0 0 0-.8-2.7A5.5 5.5 0 0 1 12.9 6ZM3.1 6h2a14 14 0 0 0 0 3h-2A5.5 5.5 0 0 1 2.5 8c0-.7.1-1.4.6-2Zm.2 4.5H5a10 10 0 0 0 .8 2.7 5.5 5.5 0 0 1-2.5-2.7Z",
        list: "M2 3h2v2H2V3Zm4 .5h8v1H6v-1ZM2 7h2v2H2V7Zm4 .5h8v1H6v-1ZM2 11h2v2H2v-2Zm4 .5h8v1H6v-1Z",
        tool: "M11.5 1.5a3.5 3.5 0 0 0-3.4 4.4L1.7 12.3l2 2 6.4-6.4a3.5 3.5 0 0 0 4.4-4.4l-1.9 1.9-1.5-.4-.4-1.5 1.9-1.9a3.5 3.5 0 0 0-1.6-.6Z",
        check: "M6.2 11.3 2.7 7.8l1-1 2.5 2.5L12.3 3.3l1 1-7.1 7Z",
        x: "M5 4 4 5l3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3-3-3Z",
        up: "M8 2.5 3 7.5h3v6h4v-6h3L8 2.5Z",
        diff: "M4 2h5l3 3v3h-1V6H8V3H4v9h3v1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm6 1.5V5h1.5L10 3.5ZM11 9h1v2h2v1h-2v2h-1v-2H9v-1h2V9Z",
        circleEmpty: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.3A4.7 4.7 0 1 1 8 12.7 4.7 4.7 0 0 1 8 3.3Z",
        circleHalf: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.3A4.7 4.7 0 1 1 8 12.7V3.3Z",
    };
    function svgIcon(name) {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("fill", "currentColor");
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
    function toolSection(label, text) {
        const sec = document.createElement("div"); sec.className = "toolsec";
        const lab = document.createElement("div"); lab.className = "tlabel"; lab.textContent = label;
        const pre = document.createElement("pre"); pre.textContent = text;
        sec.appendChild(lab); sec.appendChild(pre);
        return sec;
    }
    // Expandable tool panel (icon + verb + target, click to reveal input/result).
    function renderTool(name, detail, opts) {
        opts = opts || {};
        // A plan/todo update renders as the evolving checklist panel, not a row.
        if (opts.todos) { renderTodos(opts.todos); return null; }
        const stick = nearBottom();
        const meta = TOOL_META[name] || { icon: "tool", verb: name };
        const wrap = document.createElement("div"); wrap.className = "msg toolwrap";
        const head = document.createElement("div"); head.className = "toolrow";
        const ic = document.createElement("span"); ic.className = "tIcon"; ic.appendChild(svgIcon(meta.icon));
        const verb = document.createElement("span"); verb.className = "tVerb"; verb.textContent = meta.verb;
        head.appendChild(ic); head.appendChild(verb);
        if (detail) {
            const tg = document.createElement("span"); tg.className = "tTarget"; tg.textContent = detail;
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
        if (opts.input) { body.appendChild(toolSection("Input", opts.input)); }
        let resultSec = null;
        const showResult = (text) => {
            if (!text) return;
            if (!resultSec) { resultSec = toolSection("Result", text); body.appendChild(resultSec); }
            else { resultSec.querySelector("pre").textContent = text; }
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
        const head = document.createElement("div"); head.className = "plhead";
        const chev = svgIcon("chevron"); chev.classList.add("plchev");
        head.appendChild(svgIcon("list"));
        const ttl = document.createElement("span"); ttl.className = "pltitle"; ttl.textContent = "Plan";
        const cnt = document.createElement("span"); cnt.className = "plcount"; cnt.textContent = done + "/" + todos.length;
        head.appendChild(ttl); head.appendChild(cnt); head.appendChild(chev);
        head.addEventListener("click", () => planEl.classList.toggle("collapsed"));
        const list = document.createElement("div"); list.className = "pllist";
        for (const t of todos) {
            const item = document.createElement("div");
            item.className = "todoitem" + (t.status === "completed" ? " done" : t.status === "in_progress" ? " active" : "");
            const mk = document.createElement("span"); mk.className = "tmark" + (t.status === "pending" ? " pending" : "");
            mk.appendChild(todoMark(t.status));
            const c = document.createElement("span"); c.className = "tcontent"; c.textContent = t.content;
            item.appendChild(mk); item.appendChild(c);
            list.appendChild(item);
        }
        planEl.appendChild(head); planEl.appendChild(list);
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
            const ic = document.createElement("span"); ic.className = "cficon"; ic.appendChild(svgIcon("file"));
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
        endToolGroup();
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

    function send(modeOverride) {
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
            mode: modeOverride || sendMode.value,
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
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // Per-mode shortcuts: Ctrl/Cmd+Enter steers, Alt+Enter queues,
            // plain Enter uses the selected default mode.
            if (e.ctrlKey || e.metaKey) send("steer");
            else if (e.altKey) send("queue");
            else send();
        }
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
                if (data.whenBusy && !(saved && saved.sendMode)) { sendMode.value = data.whenBusy; }
                root.classList.toggle("chat-only", !!data.chatOnly);
                layout();
                activeSessionId = data.sessionId || "";
                startWorkingSet(activeSessionId);   // bind edited-files set to this session
                currentBackend = data.backend || "";
                currentBackendName = data.backendName || "";
                chatTitle.textContent = (data.title ? data.title + " · " : "") + (data.backendName || data.backend);
                modelDefault = data.modelDefault || "";
                modelLabels = data.modelLabels || {};
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
                permissionDefault = data.permission || "default";
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
                resetWorkingState();
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
                else if (m.role === "tool") renderTool(m.toolName || m.text, m.detail || "", { input: m.input, result: m.result, added: m.added, removed: m.removed, todos: m.todos, path: m.path });
                else message("assistant", m.text, m.ts);
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
                    if (m.role === "user") message("user", m.text, m.ts);
                    else if (m.role === "tool") renderTool(m.toolName || m.text, m.detail || "", { input: m.input, result: m.result, added: m.added, removed: m.removed, todos: m.todos, path: m.path });
                    else message("assistant", m.text, m.ts);
                }
                append("meta", data.messages.length ? "— end of stored transcript —" : "(empty transcript)");
                break;
            }
            case "user": {
                const el = message("user", data.text, Date.now());
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
            case "changed-files": {
                changedItems = data.items || [];
                renderChangedFiles();
                break;
            }
            case "event": {
                const ev = data.event;
                if (ev.kind === "text") message("assistant", ev.text, Date.now());
                else if (ev.kind === "tool-start") renderTool(ev.toolName, ev.detail || "", { toolId: ev.toolId, input: ev.input, added: ev.added, removed: ev.removed, todos: ev.todos, path: ev.path });
                else if (ev.kind === "tool-end") fillToolResult(ev.toolId, ev.result);
                else if (ev.kind === "error") append("error", "✖ " + ev.message);
                else if (ev.kind === "session") {
                    if (ev.model) { activeModel = ev.model; }
                    activeSessionId = ev.sessionId || activeSessionId;
                    bindWorkingSet(ev.sessionId);   // migrate a new session's edits to its real id
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
