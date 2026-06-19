/**
 * Shared chat webview markup for the sidebar view and the editor panel.
 *
 * Master-detail layout mirroring the built-in Chat sessions viewer: a
 * sessions list pane beside the conversation, shown automatically when the
 * surface is wide enough and collapsible behind a toggle when narrow. The
 * pane side (left/right) comes from the `meta` message.
 */
export function renderHtml(): string {
    const csp = `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
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
    /* boot/startup screen: visible immediately on parse, hidden once a session resolves */
    #bootState {
        position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 14px; padding: 24px;
        background: var(--vscode-editor-background); z-index: 50;
    }
    #root.booted #bootState { display: none; }
    #bootState .bootLogo {
        width: 52px; height: 52px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center;
        background: var(--vscode-chat-avatarBackground, var(--vscode-badge-background, rgba(128,128,128,0.18)));
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
    }
    #bootState .bootLogo svg { width: 28px; height: 28px; }
    #bootState .bootTitle { font-size: 1.1em; font-weight: 600; opacity: 0.9; letter-spacing: 0.3px; }
    #bootSteps { display: flex; flex-direction: column; gap: 6px; min-width: 220px; max-width: 80%; font-size: 0.85em; }
    .bootStep { display: flex; align-items: center; gap: 8px; opacity: 0.85; }
    .bootStep .bsIcon { width: 14px; height: 14px; flex: 0 0 14px; display: inline-flex; align-items: center; justify-content: center; }
    .bootStep .bsIcon svg { width: 13px; height: 13px; }
    .bootStep .bsLabel { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bootStep .bsDetail { opacity: 0.6; font-size: 0.92em; }
    .bootStep.pending { opacity: 0.55; }
    .bootStep.ok { opacity: 0.85; }
    .bootStep.ok .bsIcon { color: var(--vscode-charts-green, #3fb950); }
    .bootStep.fail .bsIcon { color: var(--vscode-charts-red, #f85149); }
    .bootStep.fail { opacity: 1; }
    .bootStep .bsSpin {
        width: 12px; height: 12px; border: 2px solid color-mix(in srgb, var(--vscode-foreground) 25%, transparent);
        border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
        border-radius: 50%; animation: spin 0.7s linear infinite;
    }
    #bootHint { font-size: 0.78em; opacity: 0.5; }
    /* empty state: friendly placeholder before/without any conversation */
    #emptyState {
        display: none; flex-direction: column; align-items: center; justify-content: center;
        gap: 8px; flex: 1; text-align: center; padding: 24px; opacity: 0.65;
    }
    #root.empty:not(.loading) #emptyState { display: flex; }
    #root.empty:not(.loading) #log { display: none; }
    #emptyState .esLogo {
        width: 46px; height: 46px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center;
        background: var(--vscode-chat-avatarBackground, var(--vscode-badge-background, rgba(128,128,128,0.18)));
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
    }
    #emptyState .esLogo svg { width: 24px; height: 24px; }
    #emptyState .esTitle { font-size: 1.05em; font-weight: 600; opacity: 0.9; }
    #emptyState .esHint { font-size: 0.86em; opacity: 0.7; }
    @media (prefers-reduced-motion: reduce) {
        #progress::before, .spinner { animation: none; }
        #progress.on { opacity: 1; }
        #composer.working::after { animation: none; opacity: 0.5; }
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
    #accountFooter {
        border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
        padding: 8px 10px; display: flex; align-items: center; gap: 8px;
        cursor: pointer; font-size: 0.85em;
    }
    #accountFooter:hover { background: var(--vscode-list-hoverBackground); }
    #accountFooter img { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
    #accountFooter .acc-ico {
        width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto;
        display: flex; align-items: center; justify-content: center;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 13px;
    }
    #accountFooter .acc-text { flex: 1; overflow: hidden; }
    #accountFooter .acc-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #accountFooter .acc-sub { opacity: 0.6; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #accountFooter .acc-out { opacity: 0; padding: 2px 6px; }
    #accountFooter:hover .acc-out { opacity: 0.7; }
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
    .sessionItem.pinned { cursor: grab; }
    .sessionItem.dragging { opacity: 0.5; }
    .sessionItem.dropTarget { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
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
    .sessionItem .statusDot .spinner.del {
        width: 11px; height: 11px; border-width: 2px; vertical-align: 0;
        border-top-color: var(--vscode-errorForeground, #f14c4c);
    }
    .sessionItem.deleting { opacity: 0.55; pointer-events: none; }
    .sessionItem.deleting .ttl { text-decoration: line-through; font-style: italic; }
    .sessionItem.deleting .sub { color: var(--vscode-errorForeground, #f14c4c); opacity: 0.85; }
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
        display: block; box-sizing: border-box; width: calc(100% - 16px); margin: 4px 8px 6px 8px; padding: 4px 7px;
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
    /* Message area wrapper: holds the scrollable log + the floating
       scroll-to-bottom button, so the button anchors to the bottom of the
       messages (above the queued/plan/changed-files panels), never overlapping
       their Approve/Reject buttons. */
    #logWrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
    #log {
        flex: 1; overflow-y: auto; padding: 16px 16px 6px 16px; user-select: text; cursor: text;
        font-size: 13.5px; line-height: 1.65;
    }
    .msg { margin: 0 0 18px 0; word-break: break-word; line-height: 1.65; user-select: text; -webkit-user-select: text; }
    .msg.plain { white-space: pre-wrap; }
    /* Clear separation between message blocks (not between tool rows): a hairline
       rule + breathing room above each user/assistant turn marks where one ends
       and the next begins. */
    /* Inter-turn gap lives in margin (outside the box); uniform padding keeps the
       hover highlight box symmetric around the content. The separator line sits
       at the top edge with the gap above it provided by the margin. */
    .msg.user, .msg.assistant {
        margin: 20px -10px 0 -10px; padding: 10px;
        border-top: 1px solid var(--vscode-panel-border, color-mix(in srgb, var(--vscode-foreground) 14%, transparent));
    }
    #log > .msg.user:first-child, #log > .msg.assistant:first-child { margin-top: 0; border-top: none; }
    .role { font-size: 0.82em; opacity: 1; margin-bottom: 7px; display: flex; align-items: center; gap: 6px; font-weight: 600; letter-spacing: 0.02em; color: var(--vscode-foreground); }
    .role .msgTime { font-weight: 400; opacity: 0; font-size: 0.92em; color: var(--vscode-descriptionForeground); transition: opacity 150ms ease; }
    /* messages that an in-progress edit will replace on resend */
    .msg.willReplace { opacity: 0.4; }
    #composer.editing { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); border-radius: 6px; }
    #composer.editing #input::placeholder { color: var(--vscode-focusBorder); }
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
    /* user bubble: a blue tint matching the app's own accent — derived from the
       send button's blue (button.background) so it reads unmistakably blue (not
       grey) and mirrors the native chat. button.background is the most saturated
       blue in the UI; focusBorder is the fallback. We mix it ourselves because
       many themes leave chat.requestBackground a near-invisible editor bg. */
    .ubody {
        background: color-mix(in srgb, var(--vscode-button-background, var(--vscode-focusBorder, #0078d4)) 24%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-button-background, var(--vscode-focusBorder, #0078d4)) 45%, transparent);
        border-radius: 12px 12px 3px 12px; padding: 10px 14px; white-space: pre-wrap;
        max-width: 82%; text-align: left; line-height: 1.6;
    }
    .ubody .chips { margin-top: 6px; }
    /* assistant turns: full width, no bubble (padding from the combined rule). */
    .msg.assistant { position: relative; }
    /* copy: a hover-only floating action in the corner, reserves no space */
    .msgTools { position: absolute; top: 8px; right: 8px; margin: 0; z-index: 1; }
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

    .loadOlder {
        display: block; margin: 8px auto; padding: 4px 12px;
        font-size: 11px; cursor: pointer;
        color: var(--vscode-textLink-foreground);
        background: transparent; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
        border-radius: 12px;
    }
    .loadOlder:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .branchBanner {
        display: flex; align-items: flex-start; gap: 10px;
        margin: 10px 0 14px 0; padding: 10px 12px;
        border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 45%, transparent);
        background: color-mix(in srgb, var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08)) 72%, transparent);
        border-radius: 10px;
    }
    .branchBanner .branchIcon {
        width: 22px; height: 22px; flex: 0 0 22px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 999px;
        color: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
        background: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 14%, transparent);
    }
    .branchBanner .branchIcon svg { width: 14px; height: 14px; }
    .branchBanner .branchBody { min-width: 0; }
    .branchBanner .branchTitle {
        font-weight: 600; line-height: 1.35;
        color: var(--vscode-foreground);
    }
    .branchBanner .branchDetail {
        margin-top: 2px;
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
        font-size: 0.92em; line-height: 1.45;
    }
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
    .md .mdtable { border-collapse: collapse; margin: 8px 0; font-size: 0.95em; display: block; overflow-x: auto; max-width: 100%; }
    .md .mdtable th, .md .mdtable td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); padding: 4px 9px; text-align: left; vertical-align: top; }
    .md .mdtable th { background: var(--vscode-editorWidget-background, rgba(128,128,128,0.12)); font-weight: 600; }
    .md .mdtable tr:nth-child(even) td { background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); }
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
    .tagblock {
        margin: 8px 0; border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 28%, transparent);
        border-radius: 8px; background: color-mix(in srgb, var(--vscode-editorWidget-background, #2d2d2d) 82%, transparent);
        overflow: hidden;
    }
    .tagblock summary {
        cursor: pointer; display: flex; align-items: center; gap: 8px;
        padding: 6px 9px; user-select: none;
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .tagblock summary:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)); }
    .tagblock .tagtitle { text-transform: capitalize; font-weight: 600; color: var(--vscode-foreground); }
    .tagblock .tagbadge {
        margin-left: auto; font-size: 0.72em; padding: 1px 6px; border-radius: 999px;
        color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); opacity: 0.85;
    }
    .tagblock pre {
        margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto;
        border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25));
        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08));
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: calc(var(--vscode-editor-font-size, 13px) * 0.92);
        white-space: pre-wrap;
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
    .toolsec pre.diff { padding: 4px 0; white-space: normal; }
    .toolsec .dl { display: flex; padding: 0 6px; white-space: pre-wrap; word-break: break-word; }
    .toolsec .dl .dsign { flex: 0 0 1.2em; opacity: 0.6; user-select: none; }
    .toolsec .dl .dtext { flex: 1; min-width: 0; }
    .toolsec .dl.dadd { background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #4ec94e) 14%, transparent); }
    .toolsec .dl.dadd .dsign, .toolsec .dl.dadd .dtext { color: var(--vscode-gitDecoration-addedResourceForeground, #4ec94e); }
    .toolsec .dl.ddel { background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #d16969) 14%, transparent); }
    .toolsec .dl.ddel .dsign, .toolsec .dl.ddel .dtext { color: var(--vscode-gitDecoration-deletedResourceForeground, #d16969); }
    .toolsec .dl.dctx { opacity: 0.55; }
    .toolsec pre.numbered { padding: 6px 0; white-space: normal; }
    .toolsec .ln { display: flex; }
    .toolsec .lnum {
        user-select: none; -webkit-user-select: none; flex-shrink: 0; text-align: right;
        min-width: 3.2em; padding: 0 10px 0 8px; opacity: 0.4;
        color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
    }
    .toolsec .lcode { white-space: pre-wrap; word-break: break-word; flex: 1; min-width: 0; padding-right: 8px; }
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
    /* plan / todo — rounded card pinned above the textarea, matching the
       Copilot Chat todo-list widget (bordered, inset, collapsible). */
    /* Tasks panel: a local mirror of the Sufficit-memory task list (task-anchor
       + checkpoints) for this project — the persistent "where are we" view,
       distinct from the per-conversation Plan below it. */
    #tasks { display: none; margin: 0 12px 8px 12px; }
    #tasks.has { display: block; }
    #tasks .tkcard {
        border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, rgba(128,128,128,0.25)));
        border-radius: 6px;
        background: var(--vscode-chat-requestBackground, var(--vscode-input-background, transparent));
        overflow: hidden;
    }
    #tasks .tkhead {
        display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer;
        font-size: 0.9em; user-select: none;
    }
    #tasks .tkhead:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
    #tasks .tkhead .tktitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    #tasks .tkhead .tkcount { flex-shrink: 0; opacity: 0.75; font-weight: 400; font-size: 0.92em; font-variant-numeric: tabular-nums; }
    #tasks .tkhead .tkbtn { flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 2px; opacity: 0.7; color: var(--vscode-foreground); display: inline-flex; }
    #tasks .tkhead .tkbtn:hover { opacity: 1; }
    #tasks .tkhead .tkbtn svg { width: 13px; height: 13px; }
    #tasks .tkhead svg.tkchev { width: 12px; height: 12px; flex-shrink: 0; opacity: 0.8; transition: transform 150ms ease; }
    #tasks.collapsed .tkhead svg.tkchev { transform: rotate(-90deg); }
    #tasks .tklist { max-height: 180px; overflow-y: auto; padding: 2px 8px 8px 8px; border-top: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, rgba(128,128,128,0.18))); }
    #tasks.collapsed .tklist { display: none; }
    .tkitem { display: flex; align-items: baseline; gap: 8px; padding: 3px 2px; line-height: 1.5; font-size: 0.9em; }
    .tkitem .tkbadge { flex-shrink: 0; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.03em; padding: 1px 6px; border-radius: 4px; background: var(--vscode-badge-background, rgba(128,128,128,0.25)); color: var(--vscode-badge-foreground, var(--vscode-foreground)); }
    .tkitem .tkbadge.anchor { background: color-mix(in srgb, var(--vscode-focusBorder, #0078d4) 35%, transparent); }
    .tkitem .tktext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tkitem .tkwhen { flex-shrink: 0; opacity: 0.55; font-size: 0.82em; font-variant-numeric: tabular-nums; }
    #tasks .tkempty { padding: 8px 10px; opacity: 0.6; font-size: 0.88em; }
    #plan { display: none; margin: 0 12px 8px 12px; }
    #plan.has { display: block; }
    #plan .plcard {
        border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, rgba(128,128,128,0.25)));
        border-radius: 6px;
        background: var(--vscode-chat-requestBackground, var(--vscode-input-background, transparent));
        overflow: hidden;
    }
    #plan .plhead {
        display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer;
        font-size: 0.9em; user-select: none;
    }
    #plan .plhead:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
    #plan .plhead .pltitle {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-weight: 600;
    }
    #plan .plhead .plcount {
        flex-shrink: 0; opacity: 0.75; font-weight: 400; font-size: 0.92em;
        font-variant-numeric: tabular-nums;
    }
    #plan .plhead .plbtn {
        flex-shrink: 0; width: 22px; height: 22px; background: none; border: none; cursor: pointer; padding: 3px;
        border-radius: 4px; color: var(--vscode-foreground); opacity: 0.72; display: inline-flex; align-items: center; justify-content: center;
        font: inherit;
    }
    #plan .plhead .plbtn:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
    #plan .plhead .plbtn.danger:hover:not(:disabled) { color: var(--vscode-errorForeground); }
    #plan .plhead .plbtn:disabled { opacity: 0.28; cursor: default; }
    #plan .plhead .plbtn svg { width: 13px; height: 13px; }
    #plan .plhead svg.plchev { width: 12px; height: 12px; flex-shrink: 0; opacity: 0.8; transition: transform 150ms ease; }
    #plan:not(.collapsed) .plhead svg.plchev { transform: rotate(0deg); }
    #plan.collapsed .plhead svg.plchev { transform: rotate(-90deg); }
    #plan .plactions {
        display: flex; gap: 6px; align-items: center; padding: 6px 10px;
        border-top: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, rgba(128,128,128,0.18)));
    }
    #plan.collapsed .plactions { display: none; }
    #plan .plaction {
        display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.18));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
        border-radius: 5px; padding: 3px 8px; font: inherit; font-size: 0.82em;
    }
    #plan .plaction:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.28)); }
    #plan .plaction.danger { color: var(--vscode-errorForeground); }
    #plan .plaction:disabled { opacity: 0.4; cursor: default; }
    #plan .plaction svg { width: 12px; height: 12px; }
    #plan .pllist {
        max-height: 200px; overflow-y: auto;
        padding: 2px 10px 8px 10px;
        border-top: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, rgba(128,128,128,0.18)));
    }
    #plan.collapsed .pllist { display: none; }
    .todoitem { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; line-height: 1.5; font-size: 0.9em; }
    .todoitem .torder {
        flex-shrink: 0; min-width: 2.1em; text-align: right;
        font-family: var(--vscode-editor-font-family, monospace); font-size: 0.86em;
        color: var(--vscode-descriptionForeground); opacity: 0.75; margin-top: 1px;
    }
    .todoitem .tmark { flex-shrink: 0; width: 16px; height: 16px; margin-top: 1px; display: inline-flex; align-items: center; justify-content: center; }
    .todoitem .tmark svg { width: 14px; height: 14px; }
    .todoitem.done .tcontent { opacity: 0.6; text-decoration: line-through; }
    .todoitem.active .tcontent { color: var(--vscode-foreground); font-weight: 600; }
    .todoitem.active .tmark { color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); }
    .todoitem.done .tmark { color: var(--vscode-charts-green, var(--vscode-gitDecoration-addedResourceForeground, #4ec94e)); }
    .todoitem .tmark.pending { color: var(--vscode-descriptionForeground); opacity: 0.7; }
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
    .errActions { margin-top: 6px; }
    .retryBtn {
        display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
        font: inherit; font-size: 0.9em; padding: 3px 10px; border-radius: 5px;
        color: var(--vscode-button-secondaryForeground, inherit);
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
        border: none;
    }
    .retryBtn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
    .retryBtn svg { width: 13px; height: 13px; }
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
    /* Scroll-to-bottom button: floats just above the composer, only when scrolled up. */
    #scrollBottom {
        position: absolute; bottom: 10px; right: 28px; z-index: 5;
        width: 30px; height: 30px; border-radius: 50%; cursor: pointer;
        display: none; align-items: center; justify-content: center;
        background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background, #2a2a2a));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        box-shadow: 0 2px 8px rgba(0,0,0,0.35); opacity: 0.9;
    }
    #scrollBottom.show { display: inline-flex; }
    #scrollBottom:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
    #scrollBottom svg { width: 15px; height: 15px; }
    /* Busy indicator: a subtle light sweeping around the composer border (like
       the native chat), instead of a top bar that looks global. */
    @property --symAng { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
    /* While working, neutralize the static border so the moving arc stands out
       (otherwise the blue sweep is lost against the blue focus border). */
    #composer.working, #composer.working:focus-within { border-color: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
    #composer.working::after {
        content: ""; position: absolute; inset: -1px; border-radius: 9px; padding: 1.2px;
        background: conic-gradient(from var(--symAng),
            transparent 0deg, transparent 200deg,
            color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-focusBorder, #2aa0ff)) 60%, #ffffff) 300deg,
            #ffffff 330deg,
            transparent 360deg);
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude;
        animation: symspin 1.2s linear infinite; pointer-events: none; z-index: 2;
        filter: drop-shadow(0 0 3px var(--vscode-progressBar-background, var(--vscode-focusBorder, #2aa0ff)));
    }
    @keyframes symspin { to { --symAng: 360deg; } }
    #chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 0 8px; }
    #chips:empty { display: none; }
    .chip {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 0.85em; padding: 1px 6px;
        border: 1px solid var(--vscode-input-border, #454545);
        border-radius: 4px;
        background: var(--vscode-badge-background, rgba(128,128,128,0.15));
        color: var(--vscode-badge-foreground, inherit);
        max-width: 240px;
    }
    .chip .chipIcon { width: 11px; height: 11px; opacity: 0.7; flex-shrink: 0; }
    .chip .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .chip.activeChip { border-color: var(--vscode-focusBorder); }
    /* preview-tab suggestion: dashed + dimmed, click to attach */
    .chip.clickable { cursor: pointer; }
    .chip.clickable:hover .lbl { text-decoration: underline; }
    /* attachment pills inside a user message */
    .msgAtts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; justify-content: flex-end; }
    .msgAtt {
        display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
        font-size: 0.85em; padding: 2px 8px; border-radius: 10px;
        background: var(--vscode-badge-background, rgba(128,128,128,0.25));
        color: var(--vscode-badge-foreground, var(--vscode-foreground));
    }
    .msgAtt:hover { text-decoration: underline; }
    .msgAtt .chipIcon { width: 11px; height: 11px; opacity: 0.8; }
    .chip.suggestChip { border-style: dashed; opacity: 0.6; cursor: pointer; }
    .chip.suggestChip:hover { opacity: 0.9; }
    .chip .x { cursor: pointer; opacity: 0.7; flex-shrink: 0; }
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
    #presencePicker .picon { display: inline-flex; }
    #presencePicker .picon svg { width: 12px; height: 12px; }
    #presencePicker.away { color: var(--vscode-charts-orange, #d18616); }
    #presencePicker.away .lbl { font-weight: 600; }
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
    #sendGroup.stopping button { background: var(--vscode-statusBarItem-errorBackground, var(--vscode-errorForeground, #c4314b)); }
    #sendGroup.stopping #sendCaret { border-left-color: color-mix(in srgb, var(--vscode-button-foreground) 25%, transparent); }

    /* ---- footer status bar ---- */
    #statusbar {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        padding: 3px 12px 6px 12px; font-size: 0.78em; opacity: 0.6;
        border-top: 1px solid var(--vscode-panel-border, transparent);
    }
    #statusbar .seg { display: inline-flex; align-items: center; gap: 4px; }
    #statusbar svg { width: 12px; height: 12px; }
    #statusbar:empty { display: none; }
    #statusbar .grow { flex: 1; }
    .tokenMeter {
        display: inline-flex; align-items: center; gap: 5px; background: none; border: none; cursor: pointer;
        color: inherit; font: inherit; padding: 2px 4px; border-radius: 4px; opacity: 0.85;
    }
    .tokenMeter:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .tokenMeter .tmRing { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; -webkit-mask: radial-gradient(circle 3px at center, transparent 98%, #000 100%); mask: radial-gradient(circle 3px at center, transparent 98%, #000 100%); }
    .usagePop { min-width: 230px; padding: 10px 12px; }
    .usagePop .uHead { font-weight: 600; margin-bottom: 6px; }
    .usagePop .uGroup { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55; font-weight: 600; margin: 10px 0 3px; }
    .usagePop .uRow { display: flex; justify-content: space-between; gap: 12px; font-size: 0.9em; padding: 2px 0; }
    .usagePop .uRow.uMain { opacity: 0.85; }
    .usagePop .uBar { height: 5px; border-radius: 3px; background: var(--vscode-input-background, rgba(128,128,128,0.3)); overflow: hidden; margin: 4px 0 2px; }
    .usagePop .uFill { height: 100%; background: var(--vscode-progressBar-background, #3794ff); }
    .usagePop .uCompact {
        display: block; width: 100%; margin-top: 12px; padding: 6px; cursor: pointer; border-radius: 5px;
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); color: var(--vscode-button-secondaryForeground, inherit); border: none;
    }
    .usagePop .uCompact:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }

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
    <div id="bootState">
        <div class="bootLogo"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 1.5h1V3H11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5V1.5ZM6 6.5A1 1 0 1 0 6 8.5 1 1 0 0 0 6 6.5Zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM1 6h1v4H1V6Zm13 0h1v4h-1V6Z"/></svg></div>
        <div class="bootTitle">Symposium</div>
        <div id="bootSteps"></div>
        <div id="bootHint">Iniciando…</div>
    </div>
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
        <div id="accountFooter" title="Conta Sufficit"></div>
    </aside>
    <div id="resizer" title="Drag to resize"></div>
    <main id="chatCol">
        <div id="chatHeader">
            <button id="listToggle" class="iconBtn" title="Sessions">☰</button>
            <span id="chatTitle"></span>
            <button id="switchAgentBtn" class="iconBtn" title="Switch to another model" style="display:none">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.5 1 6l3.5 3.5V7H10V5H4.5V2.5Zm7 4L15 10l-3.5 3.5V11H6V9h5.5V6.5Z"/></svg>
            </button>
        </div>
        <div id="logWrap">
            <div id="log"></div>
            <div id="emptyState">
                <div class="esLogo"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 1.5h1V3H11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5V1.5ZM6 6.5A1 1 0 1 0 6 8.5 1 1 0 0 0 6 6.5Zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM1 6h1v4H1V6Zm13 0h1v4h-1V6Z"/></svg></div>
                <div class="esTitle">Symposium</div>
                <div class="esHint">Type below to start a conversation.</div>
            </div>
            <div id="loadingState"><span class="spinner"></span><span id="loadingText">Loading session…</span></div>
            <button id="scrollBottom" title="Ir para o fim"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 13.5 13 8.5h-3v-6H6v6H3L8 13.5Z"/></svg></button>
        </div>
        <div id="queued"></div>
        <div id="tasks"></div>
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
                <button id="addBrowserPage" class="iconBtn" title="Anexar página do browser ao contexto">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM2 8h2.05c.08-1.4.36-2.66.78-3.6A6 6 0 0 0 2 8Zm2.05 1H2a6 6 0 0 0 2.83 3.6c-.42-.94-.7-2.2-.78-3.6Zm1 0c.1 1.6.46 2.9.9 3.66.2.34.38.5.55.6V9H5.05Zm0-1H7.5V4.74c-.17.1-.36.26-.55.6-.44.76-.8 2.06-.9 3.66ZM8.5 4.74V8h2.45c-.1-1.6-.46-2.9-.9-3.66-.2-.34-.38-.5-.55-.6ZM11.95 8H14a6 6 0 0 0-2.83-3.6c.42.94.7 2.2.78 3.6Zm0 1c-.08 1.4-.36 2.66-.78 3.6A6 6 0 0 0 14 9h-2.05ZM8.5 9v4.26c.17-.1.36-.26.55-.6.44-.76.8-2.06.9-3.66H8.5Z"/></svg>
                </button>
                <button id="configBtn" class="iconBtn" title="Tools & configuration">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3a2 2 0 0 1 3.9-.5H14v1H7.9A2 2 0 0 1 4 3Zm-2 .5h1.2a2 2 0 0 0 0-1H2v1Zm6 4.5a2 2 0 0 1 3.9-.5H14v1h-2.1A2 2 0 0 1 8 8Zm-6 .5h4.2a2 2 0 0 0 0-1H2v1Zm2 4.5a2 2 0 0 1 3.9-.5H14v1H7.9A2 2 0 0 1 4 13Zm-2 .5h1.2a2 2 0 0 0 0-1H2v1Z"/></svg>
                </button>
                <button id="modelPicker" class="ctl menubtn" style="display:none" title="Model — change anytime; applies to the next message"><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                <button id="reasoningPicker" class="ctl menubtn" style="display:none" title="Reasoning effort — change anytime; applies to the next message"><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                <button id="presencePicker" class="ctl menubtn" title="Presence — can be changed any time"><span class="picon"></span><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
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
    let activeFileRange = null;  // { start, end, startColumn?, endColumn? } when text is selected
    let activeFileDismissed = false;
    let activeFilePreview = false;  // VS Code preview tab (italic) → suggestion only
    let activeFilePinned = false;   // user clicked a preview suggestion to attach it
    function activeFileSuffix() {
        if (!activeFileRange) { return ""; }
        const sc = activeFileRange.startColumn, ec = activeFileRange.endColumn;
        if (activeFileRange.start === activeFileRange.end) {
            return sc && ec && sc !== ec ? ":" + activeFileRange.start + ":" + sc + "-" + ec : ":" + activeFileRange.start;
        }
        return ":" + activeFileRange.start + "-" + activeFileRange.end;
    }
    function activeFileContextNote() {
        if (!activeFileRange) { return ""; }
        const sc = activeFileRange.startColumn, ec = activeFileRange.endColumn;
        if (activeFileRange.start === activeFileRange.end) {
            return sc && ec && sc !== ec
                ? " (selected line " + activeFileRange.start + ", columns " + sc + "-" + ec + ")"
                : " (selected line " + activeFileRange.start + ")";
        }
        return " (selected lines " + activeFileRange.start + "-" + activeFileRange.end + ")";
    }
    let currentBackend = "", currentBackendName = "", agentLabels = null;
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
    const sendGroup = document.getElementById("sendGroup");
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
        // While a turn runs the main button STOPS it; idle it's a plain Send.
        // The mode caret (queue/steer for a typed follow-up) shows only when busy.
        if (busy) {
            sendGroup.classList.add("stopping");
            sendIcon.innerHTML = STOP_ICON;
            sendBtn.title = "Stop the current turn (Esc)";
            sendCaret.style.display = "";
            return;
        }
        sendGroup.classList.remove("stopping");
        sendIcon.innerHTML = MODE_ICONS.send;
        sendBtn.title = "Send (Enter)";
        sendCaret.style.display = "none";
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
        if (modelPicker.disabled) return;
        const opts = modelList.map((m) => ({ value: m, label: m === "default" ? defLabel(modelDefault) : modelLabel(m) }));
        // Always offer a manual entry so the user is never stuck when remote
        // discovery (GET /models) returned nothing — e.g. not logged in yet, or
        // the gateway answered 401. Picking it prompts for a free-form id.
        openChoiceMenu(modelPicker, opts, modelValue, (v) => { modelValue = v; setModelLabel(); }, {
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
    // Force-scroll to the very bottom, after layout settles (history/images can
    // change height a frame later, so do it now + on the next frame).
    function scrollToBottom() {
        log.scrollTop = log.scrollHeight;
        requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; updateScrollBtn(); });
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

    // --- Lazy history rendering ---------------------------------------------
    // Render the most recent messages first (so the session opens at the latest
    // turn), keeping older messages pending. When the user scrolls to the top a
    // "load older" sentinel renders the previous chunk and prepends it, keeping
    // scroll position stable. This avoids building huge transcripts oldest-first.
    const HISTORY_BATCH = 30;
    let pendingHistory = [];      // older messages not yet rendered (chronological)
    let historyCarried = false;
    let loadOlderBtn = null;

    function renderOneHistory(m) {
        if (m.role === "user") { message("user", m.text, m.ts); }
        else if (m.role === "tool") { renderTool(m.toolName || m.text, m.detail || "", { input: m.input, result: m.result, added: m.added, removed: m.removed, todos: m.todos, path: m.path, diff: m.diff }); }
        else if (m.role === "error") { append("error", "\u2716 " + m.text); }
        else { message("assistant", m.text, m.ts); }
    }

    // Move the last count freshly-appended nodes to the top of the log, before
    // the load-older button. Used to prepend an older chunk in correct order.
    function prependLastNodes(count) {
        const kids = Array.prototype.slice.call(log.children);
        const moved = [];
        for (let i = kids.length - 1, n = 0; i >= 0 && n < count; i--) {
            const el = kids[i];
            if (el === loadOlderBtn) { continue; }
            moved.unshift(el); n++;
        }
        const ref = loadOlderBtn ? loadOlderBtn.nextSibling : log.firstChild;
        for (const el of moved) { log.insertBefore(el, ref); }
    }

    function ensureLoadOlderBtn() {
        if (loadOlderBtn) { return; }
        loadOlderBtn = document.createElement("button");
        loadOlderBtn.className = "loadOlder";
        loadOlderBtn.textContent = "Load older messages";
        loadOlderBtn.addEventListener("click", loadOlderChunk);
        log.insertBefore(loadOlderBtn, log.firstChild);
    }
    function removeLoadOlderBtn() {
        if (loadOlderBtn && loadOlderBtn.parentNode) { loadOlderBtn.parentNode.removeChild(loadOlderBtn); }
        loadOlderBtn = null;
    }

    function loadOlderChunk() {
        if (!pendingHistory.length) { removeLoadOlderBtn(); return; }
        const prevH = log.scrollHeight, prevTop = log.scrollTop;
        const chunk = pendingHistory.splice(Math.max(0, pendingHistory.length - HISTORY_BATCH));
        const before = log.children.length;
        for (const m of chunk) { renderOneHistory(m); }
        const added = log.children.length - before;
        prependLastNodes(added);
        if (pendingHistory.length) { ensureLoadOlderBtn(); } else { removeLoadOlderBtn(); }
        // keep the viewport anchored on what the user was reading
        log.scrollTop = prevTop + (log.scrollHeight - prevH);
        updateScrollBtn();
    }

    function renderHistoryBatch(messages, carried) {
        pendingHistory = [];
        historyCarried = carried;
        removeLoadOlderBtn();
        const recent = messages.length > HISTORY_BATCH ? messages.slice(messages.length - HISTORY_BATCH) : messages;
        pendingHistory = messages.length > HISTORY_BATCH ? messages.slice(0, messages.length - HISTORY_BATCH) : [];
        for (const m of recent) { renderOneHistory(m); }
        if (!carried) {
            append("meta", messages.length ? "\u2014 end of stored transcript \u2014" : "(empty transcript)");
        }
        if (pendingHistory.length) { ensureLoadOlderBtn(); }
        scrollToBottom();   // land at the latest message when a session opens
    }

    // Auto-load older when the user scrolls near the top.
    log.addEventListener("scroll", () => {
        if (loadOlderBtn && log.scrollTop < 40) { loadOlderChunk(); }
    });
    // Show the empty-state placeholder when the log has no messages yet.
    function refreshEmpty() { root.classList.toggle("empty", log.childElementCount === 0); }

    // Error block with a Retry action (re-sends the last user message).
    function renderError(message, retryable) {
        const stick = nearBottom();
        endToolGroup(); endStream();
        const el = document.createElement("div"); el.className = "msg plain error";
        const txt = document.createElement("div"); txt.textContent = "✖ " + message; el.appendChild(txt);
        if (retryable && lastSendPayload) {
            // Transient/transport failure (e.g. "fetch failed"): the request was
            // valid, just didn't reach the backend. Offer only a Retry that
            // resends the exact same last submission unchanged — no editing.
            // TODO(auto-retry): VS Code chat retries transient request failures
            // automatically with exponential backoff before surfacing an error
            // to the user (see vscode-copilot-chat: the request layer wraps the
            // fetch in a retry loop keyed on transient HTTP/network errors —
            // 429/5xx/ECONNRESET/fetch-failed — with a small bounded number of
            // attempts and increasing delay, and only renders this error block
            // once retries are exhausted). To replicate here: have the OpenAI
            // adapter (src/adapters/openai.ts run()) catch retryable errors and
            // re-issue the same request N times with backoff before emitting the
            // error event, OR drive it from the controller using lastSendPayload.
            // For now retry is manual (this button); auto-retry is intentionally
            // deferred per user request.
            const bar = document.createElement("div"); bar.className = "errActions";
            const b = document.createElement("button"); b.className = "retryBtn";
            b.appendChild(svgIcon("history")); b.appendChild(document.createTextNode(" Retry"));
            b.addEventListener("click", () => { b.disabled = true; retryLast(); });
            bar.appendChild(b); el.appendChild(bar);
        } else {
            // Non-transient error: "edit & resend the last user message" — loads
            // that message back into the composer (so you can change the model,
            // text, or mode); resending rewinds the history to that point.
            const lastUser = lastUserRow();
            if (lastUser) {
                const bar = document.createElement("div"); bar.className = "errActions";
                const b = document.createElement("button"); b.className = "retryBtn";
                b.appendChild(svgIcon("history")); b.appendChild(document.createTextNode(" Edit & retry"));
                b.addEventListener("click", () => beginEdit(lastUser.idx, lastUser.text));
                bar.appendChild(b); el.appendChild(bar);
            }
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
    function message(role, text, ts) {
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
    function endStream() { streamMsg = null; streamBody = null; streamText = ""; }

    // ---- minimal, safe markdown → DOM (no innerHTML of untrusted text) ----
    // Strip memory-citation markup emitted by the Sufficit AI / responses
    // backend (e.g. <oai-mem-citation ...>text</oai-mem-citation>). Keep any
    // inner text, drop the tags. Template-safe (no single-backslash regex).
    function stripCitations(s) {
        if (s.indexOf("oai-mem-citation") < 0) return s;
        const openRe = new RegExp("<oai-mem-citation[^>]*>", "gi");
        const closeRe = new RegExp("</oai-mem-citation>", "gi");
        return s.replace(openRe, "").replace(closeRe, "");
    }

    function renderMarkdown(container, src) {
        src = stripCitations(String(src));
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
    // Tools that change a file on disk → clicking the target opens a diff.
    // Read-only tools (Read/read_file/Grep/...) just open the file.
    const MUTATING_TOOLS = new Set(["Write","Edit","MultiEdit","NotebookEdit","write_file"]);
    const TAB = String.fromCharCode(9);
    function allDigits(s) { return s.length > 0 && [...s].every((ch) => ch >= "0" && ch <= "9"); }
    // Pretty-print a string that is valid JSON (object/array) with 2-space
    // indentation; returns the original string unchanged otherwise.
    function beautifyJson(text) {
        const t = String(text).trim();
        if (!t || (t[0] !== "{" && t[0] !== "[")) { return text; }
        try { return JSON.stringify(JSON.parse(t), null, 2); }
        catch (_e) { return text; }
    }
    // Tool output from Read comes as "  <n>\t<code>"; split the line number into
    // a non-selectable gutter so copying the result never includes the numbers.
    function toolSection(label, text) {
        text = beautifyJson(text);
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
                const mut = MUTATING_TOOLS.has(name);
                tg.classList.add("tLink"); tg.title = opts.path + (mut ? " — click for diff, right-click for more" : " — click to open, right-click for more");
                tg.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: mut ? "file-diff" : "open-file", path: opts.path }); });
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
                const w = document.createElement("span"); w.className = "spinner del"; w.title = "Deleting…"; statusDot.appendChild(w);
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
            const statusText = s.deleting ? "deleting… · " : (s.status === "working" ? "working… · " : (s.status === "idle" ? "live · " : ""));
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

            // One "more" button opens the same menu as right-click.
            const acts = document.createElement("div");
            acts.className = "acts";
            const more = document.createElement("button");
            more.appendChild(svgIcon("more")); more.title = "Actions";
            more.addEventListener("click", (ev) => { ev.stopPropagation(); showCtx(ev, s); });
            acts.appendChild(more);

            el.appendChild(statusDot);
            el.appendChild(body);
            el.appendChild(acts);
            el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); showCtx(ev, s); });
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
    // Close on page scroll, but NOT when scrolling inside the menu's own list.
    document.addEventListener("scroll", (e) => {
        if (ctxMenu.contains(e.target)) { return; }
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
        if (!text) return;
        // While a turn runs, only queue/steer may submit; plain send waits too
        // (the extension queues it), so allow submitting in every mode.
        input.value = "";
        const atts = attachments.map((a) => a.path);
        // A preview-tab file is only attached when the user pinned it (clicked the
        // suggestion); a really-open file auto-attaches as before.
        if (activeFile && !activeFileDismissed && (!activeFilePreview || activeFilePinned)) {
            atts.unshift(activeFile + activeFileContextNote());
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
    sendBtn.addEventListener("click", () => { if (busy) { vscode.postMessage({ type: "cancel" }); } else { send(); } });
    addContext.addEventListener("click", () => vscode.postMessage({ type: "pick-attachments" }));
    const addBrowserPage = document.getElementById("addBrowserPage");
    if (addBrowserPage) { addBrowserPage.addEventListener("click", () => vscode.postMessage({ type: "attach-browser-page" })); }
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
                modelDefault = data.modelDefault || "";
                modelLabels = data.modelLabels || {};
                reasoningDefault = data.reasoningDefault || "";
                modelList = data.models || [];
                // Keep the user's chosen model across re-meta (e.g. edit-resend,
                // handoff) when it's still offered; only fall back to the default.
                if (!modelValue || (modelValue !== "default" && !modelList.includes(modelValue))) {
                    modelValue = modelList[0] || "";
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
                activeFileRange = (data.activeFileStart && data.activeFileEnd)
                    ? { start: data.activeFileStart, end: data.activeFileEnd, startColumn: data.activeFileStartColumn, endColumn: data.activeFileEndColumn }
                    : null;
                activeFilePreview = !!data.activeFilePreview; activeFilePinned = false;
                activeFileDismissed = false; renderChips();
                setLoading(false);   // session resolved — reveal the conversation
                scrollToBottom();    // start at the latest message
                break;
            }
            case "active-file": {
                // Editor switched or selection changed — refresh the context chip.
                // Keep it dismissed only while the same file stays active.
                if (data.path !== activeFile) { activeFileDismissed = false; activeFilePinned = false; }
                activeFile = data.path || null;
                activeFileRange = (data.start && data.end)
                    ? { start: data.start, end: data.end, startColumn: data.startColumn, endColumn: data.endColumn }
                    : null;
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
                else if (m.role === "tool") renderTool(m.toolName || m.text, m.detail || "", { input: m.input, result: m.result, added: m.added, removed: m.removed, todos: m.todos, path: m.path, diff: m.diff });
                else message("assistant", m.text, m.ts);
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
            case "history": {
                clearTimeout(bootTimer); bootStep("host", null, "ok"); bootStep("session", "Sessão pronta", "ok"); bootComplete();
                if (data.carried && data.branchLabel) {
                    branchBanner(data.branchLabel.title, data.branchLabel.detail);
                }
                // Lazy history: render only the most recent batch immediately and
                // keep older messages pending, prepended on scroll-to-top. This
                // lands the view on the latest message right away instead of
                // building the whole transcript oldest-first.
                renderHistoryBatch(data.messages || [], !!data.carried);
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
                        const cleanPath = String(p).replace(/ [(]selected line.*$/, "");
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
                if (ev.kind === "text") streamDelta(ev.text);
                else if (ev.kind === "tool-start") { endStream(); renderTool(ev.toolName, ev.detail || "", { toolId: ev.toolId, input: ev.input, added: ev.added, removed: ev.removed, todos: ev.todos, path: ev.path }); }
                else if (ev.kind === "tool-output") fillToolResult(ev.toolId, ev.text);
                else if (ev.kind === "tool-end") fillToolResult(ev.toolId, ev.result);
                else if (ev.kind === "usage") { lastUsage = ev; renderStatusbar(); }
                else if (ev.kind === "error") {
                    // Defensive: an error must never leave the composer stuck busy.
                    busy = false; sendBtn.disabled = false; setStatus();
                    renderError(ev.message, ev.retryable);
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

    // ---- Boot/startup screen -------------------------------------------------
    // Shown immediately on parse so the panel never looks frozen. Lists the boot
    // steps with live status (pending/ok/fail) to aid diagnostics. The extension
    // may push {type:"boot", id, label, status, detail} to add/update steps;
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
    }
    function bootStep(id, label, status, detail) {
        if (bootDone && status === "ok") { return; }
        renderBootStep(id, label, status, detail);
    }
    function bootComplete() {
        if (bootDone) { return; }
        bootDone = true;
        root.classList.add("booted");
    }
    // Seed the steps we know about up front (extension confirms/overrides them).
    bootStep("host", "Conectando ao host da extensão", "pending");
    bootStep("ui", "Carregando interface", "ok");
    bootStep("session", "Preparando sessão", "pending");
    // Safety: if nothing resolves in 12s, surface a warning but reveal the UI.
    const bootTimer = setTimeout(() => {
        if (bootDone) { return; }
        bootHintEl.textContent = "Demorando mais que o esperado — veja Output › Symposium para diagnóstico.";
    }, 12000);

    setStatus();
    refreshEmpty();   // show the placeholder until a conversation loads
    // Handshake: the extension queues everything until this script is live,
    // so meta/history posted right after construction are never lost.
    vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
