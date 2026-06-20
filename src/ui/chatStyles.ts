/**
 * Chat webview styles — extracted from chatHtml.ts (single-source split).
 * Pure CSS injected into <style>; no template interpolation.
 */
export const chatStyles = `    body {
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
        display: inline-block; width: 16px; height: 16px; vertical-align: -3px;
        border: 2px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
        border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
        border-radius: 50%; animation: spin 0.75s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes ldFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes ldPulse { 0%, 100% { opacity: 0.65; } 50% { opacity: 1; } }
    #loadingState {
        display: none; flex-direction: column; align-items: center; justify-content: center;
        gap: 16px; flex: 1;
    }
    #root.loading #loadingState { display: flex; animation: ldFadeIn 0.22s ease; }
    #root.loading #log { display: none; }
    #loadingState .ldLogo {
        width: 56px; height: 56px; border-radius: 16px; display: inline-flex;
        align-items: center; justify-content: center; position: relative;
        background: linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #2563EB 100%);
        color: white;
        box-shadow: 0 0 12px rgba(124, 58, 237, 0.4);
        animation: bootLogoPulse 2.5s ease-in-out infinite;
    }
    #loadingState .ldLogo svg { width: 34px; height: 34px; }
    #loadingState .ldLogo::after {
        content: ""; position: absolute; inset: -5px; border-radius: 21px; padding: 2px; pointer-events: none;
        background: conic-gradient(from var(--bootAng),
            transparent 0deg, transparent 170deg,
            rgba(167, 139, 250, 0.75) 230deg,
            rgba(147, 197, 253, 0.95) 290deg,
            #ffffff 320deg, transparent 360deg);
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        mask-composite: exclude;
        animation: bootRingSpin 2s linear infinite;
    }
    #loadingState .ldName { font-size: 0.95em; font-weight: 700; letter-spacing: 0.5px; background: linear-gradient(90deg, #7C3AED, #2563EB); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    #loadingState .ldSub { display: flex; align-items: center; gap: 7px; font-size: 0.82em; opacity: 0.5; }
    /* boot/startup screen: visible immediately on parse, hidden once a session resolves */
    #bootState {
        position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 14px; padding: 24px;
        background: var(--vscode-editor-background); z-index: 50;
    }
    #root.booted #bootState { display: none; }
    #bootState .bootLogo {
        width: 56px; height: 56px; border-radius: 16px; display: inline-flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #2563EB 100%);
        color: white; position: relative;
        box-shadow: 0 0 12px rgba(124, 58, 237, 0.4);
        animation: bootLogoPulse 2.5s ease-in-out infinite;
    }
    #bootState .bootLogo svg { width: 34px; height: 34px; }
    @property --bootAng { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
    #bootState .bootLogo::after {
        content: ""; position: absolute; inset: -5px; border-radius: 21px; padding: 2px; pointer-events: none;
        background: conic-gradient(from var(--bootAng),
            transparent 0deg, transparent 170deg,
            rgba(167, 139, 250, 0.75) 230deg,
            rgba(147, 197, 253, 0.95) 290deg,
            #ffffff 320deg, transparent 360deg);
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        mask-composite: exclude;
        animation: bootRingSpin 2s linear infinite;
    }
    @keyframes bootRingSpin { to { --bootAng: 360deg; } }
    @keyframes bootLogoPulse {
        0%, 100% { box-shadow: 0 0 12px rgba(124, 58, 237, 0.4); }
        50% { box-shadow: 0 0 28px rgba(124, 58, 237, 0.65), 0 0 50px rgba(37, 99, 235, 0.25); }
    }
    #bootState .bootTitle { font-size: 1.1em; font-weight: 700; letter-spacing: 0.5px; background: linear-gradient(90deg, #7C3AED, #2563EB); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
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
    #emptyState .esCta {
        margin-top: 8px; display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 14px; border-radius: 5px; cursor: pointer; font: inherit; font-size: 0.9em;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border: none; transition: background-color 150ms ease;
    }
    #emptyState .esCta:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
    #emptyState .esCta svg { width: 13px; height: 13px; }
    @media (prefers-reduced-motion: reduce) {
        #progress::before, .spinner { animation: none; }
        #progress.on { opacity: 1; }
        #composer.working::after { animation: none; opacity: 0.5; }
        #loadingState { animation: none; }
        #bootState .ldLogo, #loadingState .ldLogo { animation: none; opacity: 0.85; }
        #bootState .bootLogo, #loadingState .ldLogo { animation: none; box-shadow: 0 0 0 2px rgba(124,58,237,0.5) inset; }
        #bootState .bootLogo::after, #loadingState .ldLogo::after { animation: none; opacity: 0; }
        #ctxMenu { animation: none; }
        .sessionItem .statusDot .work { animation: none; }
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
        padding: 10px 12px 4px 12px; font-size: 0.8em; text-transform: uppercase;
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
    .sessionItem .body { flex: 1; min-width: 0; }
    .sessionItem .ttl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sessionItem .sub { opacity: 0.6; font-size: 0.85em; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sessionItem.archived .ttl { opacity: 0.6; font-style: italic; }
    .sessionItem .acts { display: none; flex-shrink: 0; gap: 1px; }
    .sessionItem:hover .acts { display: flex; }
    .sessionItem:focus-within .acts { display: flex; }
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
        position: fixed; z-index: 50; display: none; min-width: 220px; max-width: 340px;
        background: var(--vscode-menu-background, var(--vscode-editor-background));
        color: var(--vscode-menu-foreground, var(--vscode-foreground));
        border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #454545));
        border-radius: 6px; padding: 4px 0; box-shadow: 0 4px 18px rgba(0,0,0,0.35);
        animation: menuIn 0.13s ease;
    }
    @keyframes menuIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    #ctxMenu .mi { padding: 6px 12px; cursor: pointer; font-size: 0.9em; transition: background 100ms ease; }
    #ctxMenu .mi:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
    #ctxMenu .mi.danger { color: var(--vscode-errorForeground); }
    #ctxMenu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, rgba(128,128,128,0.3)); }
    #ctxMenu .menuSearch {
        display: block; box-sizing: border-box; width: calc(100% - 16px); margin: 4px 8px 6px 8px; padding: 4px 7px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #454545); border-radius: 4px; outline: none; font-family: inherit; font-size: 0.9em;
    }
    #ctxMenu .menuSearch:focus { border-color: var(--vscode-focusBorder); }
    #ctxMenu .menuList { max-height: 320px; overflow-y: auto; }
    #ctxMenu .menuGroup { padding: 8px 12px 3px; font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.07em; opacity: 0.45; font-weight: 700; }
    #ctxMenu .mi { display: flex; align-items: center; gap: 8px; }
    #ctxMenu .mi .tick { width: 13px; flex-shrink: 0; color: var(--vscode-focusBorder); }
    #ctxMenu .mi .miico { flex-shrink: 0; opacity: 0.55; display: flex; align-items: center; }
    #ctxMenu .mi .milbl { flex: 1; overflow: hidden; }
    #ctxMenu .mi .milbl-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #ctxMenu .mi.active .milbl-text { color: var(--vscode-focusBorder); font-weight: 600; }
    #ctxMenu .mi .milbl-desc { font-size: 0.77em; opacity: 0.52; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    #ctxMenu .mi .midetail { opacity: 0.5; font-size: 0.85em; flex-shrink: 0; }
    #ctxMenu .mi .miacts { display: none; flex-shrink: 0; gap: 1px; }
    #ctxMenu .mi:hover .miacts { display: inline-flex; }
    #ctxMenu .mi .miact { background: none; border: none; cursor: pointer; padding: 2px 3px; border-radius: 3px; opacity: 0.55; display: inline-flex; color: inherit; }
    #ctxMenu .mi .miact:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    #ctxMenu .mi .miact.on { opacity: 0.9; color: var(--vscode-focusBorder, #7C3AED); }
    #ctxMenu .mi .miact svg { width: 13px; height: 13px; }

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
    .role .msgTime { font-weight: 400; opacity: 0.4; font-size: 0.92em; color: var(--vscode-descriptionForeground); transition: opacity 150ms ease; }
    /* messages that an in-progress edit will replace on resend */
    .msg.willReplace { opacity: 0.4; }
    #composer.editing { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); border-radius: 6px; }
    #composer.editing #input::placeholder { color: var(--vscode-focusBorder); }
    .msg:hover .role .msgTime { opacity: 0.75; }
    /* Role label hidden when same backend+model as prev assistant message; revealed on hover */
    .role.rolePassive { max-height: 0; margin-bottom: 0; overflow: hidden; opacity: 0; pointer-events: none; transition: max-height 180ms ease, margin-bottom 180ms ease, opacity 180ms ease; }
    .msg:hover .role.rolePassive { max-height: 28px; margin-bottom: 7px; opacity: 1; pointer-events: auto; }
    @media (prefers-reduced-motion: reduce) { .role.rolePassive, .msg:hover .role.rolePassive { transition: none; } }
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
        padding: 3px 8px; font-size: 0.82em; opacity: 0.8;
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
        font-size: 0.82em; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
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

    /* ---- thinking / extended reasoning block ---- */
    .thinkWrap { margin: 4px -10px 8px -10px; padding: 0 10px; }
    .thinkBlock {
        border-left: 2px solid color-mix(in srgb, var(--vscode-focusBorder, #7C3AED) 60%, transparent);
        border-radius: 0 4px 4px 0;
        background: color-mix(in srgb, var(--vscode-focusBorder, #7C3AED) 5%, transparent);
        overflow: hidden;
    }
    .thinkBlock summary { list-style: none; }
    .thinkBlock summary::-webkit-details-marker { display: none; }
    .thinkSum {
        display: flex; align-items: center; gap: 6px; padding: 5px 10px; cursor: pointer;
        font-size: 0.82em; font-weight: 600; opacity: 0.7; user-select: none;
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
        transition: opacity 120ms ease;
    }
    .thinkSum:hover { opacity: 1; }
    .thinkSum svg { width: 13px; height: 13px; flex-shrink: 0; color: var(--vscode-focusBorder, #7C3AED); }
    .thinkChev { width: 10px; height: 10px; flex-shrink: 0; transition: transform 150ms ease; opacity: 0.6; }
    details.thinkBlock[open] .thinkChev { transform: rotate(90deg); }
    .thinkLen { margin-left: auto; font-weight: 400; opacity: 0.55; font-size: 0.88em; font-variant-numeric: tabular-nums; }
    .thinkBody {
        padding: 4px 12px 10px 12px; font-size: 0.88em; line-height: 1.6;
        white-space: pre-wrap; word-break: break-word; opacity: 0.72;
        color: var(--vscode-foreground); border-top: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #7C3AED) 20%, transparent);
        max-height: 400px; overflow-y: auto;
    }

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
        transition: background-color 200ms ease, opacity 150ms ease;
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
    /* While a turn runs: the send button previews the next message's fate.
       Queue = neutral accent (wait), Steer = warning accent (interrupt). */
    #sendGroup.busy button { background: color-mix(in srgb, var(--vscode-button-background) 55%, var(--vscode-badge-background, #4d4d4d)); }
    #sendGroup.busy.steer button { background: var(--vscode-statusBarItem-warningBackground, var(--vscode-editorWarning-foreground, #cca700)); color: var(--vscode-statusBarItem-warningForeground, #000); }

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
    #root.narrow #resizer, #root.chat-only #resizer { display: none; }`;
