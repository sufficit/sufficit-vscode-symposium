/**
 * Symposium configuration webview styles.
 *
 * Extracted from configHtml.ts so the markup module stays focused on structure
 * and message wiring. Injected verbatim into the panel's inline <style> (the CSP
 * allows 'unsafe-inline' styles only).
 *
 * Design intent: base colors stay tied to VS Code theme vars so light/dark both
 * keep working, while a fixed indigo→violet brand accent (+ a green
 * "healthy/run" layer) gives the panel its own identity, distinct from the
 * default settings editor.
 */
export const configStyles = /* css */ `
    /* ===== Symposium config — design tokens ============================== */
    :root {
        --sym-accent: #7c6cff;            /* indigo-violet brand */
        --sym-accent-2: #b06cff;          /* violet */
        --sym-accent-grad: linear-gradient(135deg, #7c6cff 0%, #b06cff 100%);
        --sym-ok: #3fb950;
        --sym-warn: #d9a45b;
        --sym-bad: #e26d6d;
        /* Surfaces tinted from the theme foreground so they read on any theme. */
        --sym-surface: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
        --sym-surface-2: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
        --sym-border: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
        --sym-border-soft: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
        --sym-radius: 10px;
        --sym-radius-sm: 7px;
        --sym-ease: cubic-bezier(.2,.7,.3,1);
    }
    *:focus-visible {
        outline: 2px solid var(--sym-accent);
        outline-offset: 2px; border-radius: 4px;
    }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: transparent;
        margin: 0; padding: 0; height: 100vh; overflow: hidden;
        display: flex; flex-direction: column;
    }

    /* ---- Header: brand bar with accent wash --------------------------------- */
    header {
        padding: 13px 18px; position: relative;
        border-bottom: 1px solid var(--sym-border-soft);
        display: flex; align-items: center; gap: 13px; flex-wrap: wrap; flex-shrink: 0;
        background:
            radial-gradient(120% 180% at 0% 0%, color-mix(in srgb, var(--sym-accent) 13%, transparent) 0%, transparent 55%),
            var(--sym-surface);
    }
    header::after {
        content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
        background: var(--sym-accent-grad); opacity: .55;
    }
    header strong {
        font-size: 1.05em; letter-spacing: .2px;
        display: inline-flex; align-items: center; gap: 8px;
    }
    header strong::before {
        content: ""; width: 10px; height: 18px; border-radius: 3px;
        background: var(--sym-accent-grad);
        box-shadow: 0 0 10px color-mix(in srgb, var(--sym-accent) 60%, transparent);
    }
    header .root {
        opacity: .7; font-family: var(--vscode-editor-font-family); font-size: .85em;
        padding: 2px 8px; border-radius: 6px; background: var(--sym-surface-2);
    }
    .health {
        padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
        display: inline-flex; align-items: center; gap: 6px;
        border: 1px solid var(--sym-border);
    }
    .health::before {
        content: ""; width: 7px; height: 7px; border-radius: 50%;
        background: currentColor; box-shadow: 0 0 0 0 currentColor;
    }
    .health.ok { color: var(--sym-ok); background: color-mix(in srgb, var(--sym-ok) 14%, transparent); border-color: color-mix(in srgb, var(--sym-ok) 35%, transparent); }
    .health.ok::before { animation: sym-pulse 2s var(--sym-ease) infinite; }
    .health.down { color: var(--sym-bad); background: color-mix(in srgb, var(--sym-bad) 14%, transparent); border-color: color-mix(in srgb, var(--sym-bad) 35%, transparent); }
    .health.unauthorized { color: var(--sym-warn); background: color-mix(in srgb, var(--sym-warn) 14%, transparent); border-color: color-mix(in srgb, var(--sym-warn) 35%, transparent); }
    .health.unknown { color: var(--vscode-descriptionForeground); background: var(--sym-surface-2); }
    @keyframes sym-pulse {
        0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 60%, transparent); }
        70% { box-shadow: 0 0 0 6px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
    }

    /* ---- Buttons ------------------------------------------------------------ */
    button {
        font: inherit; font-weight: 500; color: var(--vscode-button-foreground);
        background: var(--vscode-button-background); border: none;
        padding: 6px 13px; border-radius: var(--sym-radius-sm); cursor: pointer;
        transition: transform 120ms var(--sym-ease), background 150ms ease, box-shadow 150ms ease, opacity 150ms ease;
    }
    button:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button.secondary {
        color: var(--vscode-foreground);
        background: var(--sym-surface-2);
        border: 1px solid var(--sym-border);
    }
    button.secondary:hover { background: var(--sym-surface); border-color: color-mix(in srgb, var(--sym-accent) 45%, var(--sym-border)); }
    button.primary {
        color: #fff; background: var(--sym-accent-grad); border: none;
        box-shadow: 0 2px 12px color-mix(in srgb, var(--sym-accent) 35%, transparent);
    }
    button.primary:hover { box-shadow: 0 4px 18px color-mix(in srgb, var(--sym-accent) 50%, transparent); }
    button.danger { color: var(--sym-bad); background: transparent; border: 1px solid color-mix(in srgb, var(--sym-bad) 40%, transparent); }
    button.danger:hover { background: color-mix(in srgb, var(--sym-bad) 16%, transparent); }

    /* ---- Tabs: segmented pills with sliding accent -------------------------- */
    nav {
        display: flex; gap: 4px; padding: 9px 18px; flex-shrink: 0; flex-wrap: wrap;
        border-bottom: 1px solid var(--sym-border-soft);
    }
    nav .tab {
        padding: 7px 13px; cursor: pointer; border: 1px solid transparent;
        border-radius: 999px; opacity: .7; font-weight: 500; position: relative;
        display: inline-flex; align-items: center; gap: 6px;
        transition: opacity 150ms ease, background 150ms ease, color 150ms ease, border-color 150ms ease, transform 120ms var(--sym-ease);
    }
    nav .tab:hover { opacity: 1; background: var(--sym-surface); transform: translateY(-1px); }
    nav .tab.active {
        opacity: 1; color: #fff; border-color: transparent;
        background: var(--sym-accent-grad);
        box-shadow: 0 2px 10px color-mix(in srgb, var(--sym-accent) 35%, transparent);
    }
    nav .tab .count {
        font-size: .82em; font-weight: 600; min-width: 18px; text-align: center;
        padding: 1px 6px; border-radius: 999px;
        background: var(--sym-surface-2); opacity: .85;
    }
    nav .tab.active .count { background: rgba(255,255,255,.22); opacity: 1; }

    main { flex: 1; min-height: 0; overflow: auto; padding: 20px 0 40px; }
    .page { max-width: 980px; margin: 0 auto; padding: 0 18px; animation: sym-fade 220ms var(--sym-ease); }
    @keyframes sym-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    main > .page > h2 { font-size: 1.15em; margin: 0 0 10px; }

    /* ---- Resource / list rows: card with accent reveal ---------------------- */
    .row {
        display: flex; align-items: center; gap: 11px; padding: 11px 13px;
        border-radius: var(--sym-radius-sm); cursor: pointer; position: relative;
        border: 1px solid var(--sym-border-soft); margin-bottom: 6px;
        background: var(--sym-surface);
        transition: background 150ms ease, border-color 150ms ease, transform 120ms var(--sym-ease);
    }
    .row::before {
        content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px;
        border-radius: 3px; background: var(--sym-accent-grad);
        opacity: 0; transform: scaleY(.4); transition: opacity 150ms ease, transform 150ms var(--sym-ease);
    }
    .row:hover {
        background: var(--sym-surface-2);
        border-color: color-mix(in srgb, var(--sym-accent) 35%, var(--sym-border-soft));
        transform: translateX(2px);
    }
    .row:hover::before { opacity: 1; transform: scaleY(1); }
    .row .name { font-weight: 600; }
    .row .ver {
        font-size: 10px; font-weight: 600; font-family: var(--vscode-editor-font-family);
        color: var(--sym-ok); flex: 0 0 auto;
        border: 1px solid color-mix(in srgb, var(--sym-ok) 40%, transparent);
        background: color-mix(in srgb, var(--sym-ok) 12%, transparent);
        padding: 1px 7px; border-radius: 999px;
    }
    .row .badge {
        font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
        color: var(--sym-accent-2);
        border: 1px solid color-mix(in srgb, var(--sym-accent) 40%, transparent);
        background: color-mix(in srgb, var(--sym-accent) 12%, transparent);
        padding: 1px 7px; border-radius: 999px;
    }
    .row .desc { opacity: .7; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .del {
        opacity: 0; cursor: pointer; padding: 2px 7px; border-radius: 6px; flex: 0 0 auto;
        color: var(--sym-bad); transition: opacity 150ms ease, background 150ms ease;
    }
    .row:hover .del { opacity: .85; }
    .row .del:hover { background: color-mix(in srgb, var(--sym-bad) 18%, transparent); opacity: 1; }

    .toolbar { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
    .empty {
        opacity: .75; padding: 40px 16px; text-align: center; line-height: 1.6;
        border: 1px dashed var(--sym-border); border-radius: var(--sym-radius);
        background: var(--sym-surface);
    }
    .desc { opacity: .7; line-height: 1.5; }

    /* ---- Backends ----------------------------------------------------------- */
    .bk {
        padding: 13px 14px; margin-bottom: 8px; border-radius: var(--sym-radius);
        border: 1px solid var(--sym-border-soft); background: var(--sym-surface);
        transition: border-color 150ms ease, background 150ms ease;
    }
    .bk:hover { border-color: var(--sym-border); background: var(--sym-surface-2); }
    .bk-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .bk-head .name { font-weight: 600; }
    .bk-head .desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bk-test { font-size: .85em; opacity: .75; flex: 0 0 auto; }
    .bk-cfg { display: flex; gap: 8px; margin: 11px 0 0 20px; align-items: center; flex-wrap: wrap; }
    .dot {
        width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
        background: var(--vscode-descriptionForeground);
    }
    .dot.ok { background: var(--sym-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sym-ok) 22%, transparent); }
    .dot.no { background: var(--sym-bad); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sym-bad) 22%, transparent); }

    /* ---- Inputs ------------------------------------------------------------- */
    input, select {
        font: inherit; color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--sym-border); border-radius: var(--sym-radius-sm);
        padding: 6px 9px; transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    input:hover, select:hover { border-color: color-mix(in srgb, var(--sym-accent) 40%, var(--sym-border)); }
    input:focus-visible, select:focus-visible {
        outline: none; border-color: var(--sym-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sym-accent) 25%, transparent);
    }

    /* ---- Sections + preference rows ----------------------------------------- */
    .section { margin-bottom: 26px; }
    .section-title {
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em;
        color: var(--sym-accent-2); opacity: .9;
        padding-bottom: 9px; margin-bottom: 8px;
        border-bottom: 1px solid var(--sym-border-soft);
        display: flex; align-items: center; gap: 8px;
    }
    .section-title::before {
        content: ""; width: 5px; height: 5px; border-radius: 50%;
        background: var(--sym-accent); box-shadow: 0 0 8px var(--sym-accent);
    }
    .pref-item {
        display: grid; grid-template-columns: 1fr 250px; gap: 18px;
        align-items: center; padding: 13px 14px; border-radius: var(--sym-radius-sm);
        border: 1px solid transparent; margin-bottom: 4px;
        transition: background 150ms ease, border-color 150ms ease;
    }
    .pref-item:hover { background: var(--sym-surface); border-color: var(--sym-border-soft); }
    .pref-item .meta { min-width: 0; }
    .pref-item .name { font-weight: 600; display: block; margin-bottom: 3px; }
    .pref-item .desc { opacity: .68; font-size: .9em; line-height: 1.5; white-space: normal; }
    .pref-item .ctl { justify-self: end; width: 100%; }
    .pref-item select.pref { width: 100%; cursor: pointer; min-height: 32px; }

    /* ---- Compression presets: card grid ------------------------------------- */
    .presets-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
        gap: 12px; margin-top: 12px;
    }
    .preset-actions { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
    .card {
        border: 1px solid var(--sym-border-soft); border-radius: var(--sym-radius);
        background: var(--sym-surface); padding: 14px; position: relative; overflow: hidden;
        display: flex; flex-direction: column; gap: 9px;
        transition: border-color 150ms ease, transform 120ms var(--sym-ease), box-shadow 150ms ease;
    }
    .card::before {
        content: ""; position: absolute; inset: 0 auto 0 0; width: 3px;
        background: var(--sym-accent-grad); opacity: .5;
    }
    .card:hover {
        transform: translateY(-2px); border-color: color-mix(in srgb, var(--sym-accent) 35%, var(--sym-border-soft));
        box-shadow: 0 6px 20px color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
    }
    .card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .card-body { font-size: .88em; opacity: .8; line-height: 1.7; }
    .card-body strong { font-weight: 600; opacity: .9; }
    .card-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
    .preset-name { font-weight: 700; }
    .preset-desc { opacity: .7; font-size: .9em; line-height: 1.4; }
    .badge {
        font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
        background: var(--sym-surface-2); color: var(--vscode-foreground);
    }
    .badge-default {
        background: var(--sym-accent-grad); color: #fff;
        box-shadow: 0 1px 6px color-mix(in srgb, var(--sym-accent) 40%, transparent);
    }

    /* ---- MCP servers list --------------------------------------------------- */
    .resources { display: flex; flex-direction: column; gap: 8px; }
    .resource-item {
        border: 1px solid var(--sym-border-soft); border-radius: var(--sym-radius);
        background: var(--sym-surface); padding: 13px 14px;
        transition: border-color 150ms ease, background 150ms ease;
    }
    .resource-item:hover { border-color: var(--sym-border); background: var(--sym-surface-2); }
    .resource-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .resource-name { font-weight: 600; }
    .resource-desc { opacity: .72; font-size: .9em; line-height: 1.5; margin-top: 5px; }
    .resource-meta {
        margin-top: 7px; font-size: .82em; opacity: .85;
        display: inline-block; padding: 2px 9px; border-radius: 999px;
        background: color-mix(in srgb, var(--sym-accent) 12%, transparent);
        color: var(--sym-accent-2);
    }

    /* ---- MCP servers: expandable cards with discovered items ---------------- */
    .mcp-server {
        border: 1px solid var(--sym-border-soft); border-radius: var(--sym-radius);
        background: var(--sym-surface); margin-bottom: 8px; overflow: hidden;
        transition: border-color 150ms ease;
    }
    .mcp-server:hover { border-color: var(--sym-border); background: var(--sym-surface-2); }
    .mcp-server.open { border-color: color-mix(in srgb, var(--sym-accent) 35%, var(--sym-border-soft)); }
    .mcp-head {
        display: flex; align-items: center; gap: 10px; padding: 13px 14px; cursor: pointer;
    }
    .mcp-head .resource-meta { margin-top: 0; }
    .mcp-caret { flex: 0 0 auto; opacity: .6; transition: transform 150ms var(--sym-ease); display: inline-block; }
    .mcp-server.open .mcp-caret { transform: rotate(90deg); color: var(--sym-accent-2); opacity: 1; }
    .mcp-transport {
        flex: 0 0 auto; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
        font-family: var(--vscode-editor-font-family);
        color: var(--sym-accent-2); padding: 1px 8px; border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--sym-accent) 40%, transparent);
        background: color-mix(in srgb, var(--sym-accent) 12%, transparent);
    }
    .mcp-spacer { flex: 1; }
    .mcp-server .resource-desc { padding: 0 14px 12px 36px; }
    .mcp-detail { display: none; padding: 4px 14px 14px 36px; }
    .mcp-server.open .mcp-detail { display: block; animation: sym-fade 180ms var(--sym-ease); }
    .mcp-cfg-row { display: flex; gap: 10px; padding: 4px 0; font-size: .88em; align-items: baseline; }
    .mcp-cfg-k {
        flex: 0 0 88px; text-transform: uppercase; font-size: .82em; letter-spacing: .06em;
        font-weight: 600; opacity: .55;
    }
    .mcp-cfg-v { flex: 1; min-width: 0; word-break: break-word; }
    .mcp-cfg-v.mono { font-family: var(--vscode-editor-font-family); opacity: .85; }
    .mcp-group { margin-top: 12px; }
    .mcp-group-title {
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
        opacity: .6; margin-bottom: 6px; display: flex; align-items: center; gap: 7px;
    }
    .mcp-group-count {
        font-size: 10px; padding: 0 7px; border-radius: 999px;
        background: var(--sym-surface-2); opacity: .9;
    }
    .mcp-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 5px; }
    .mcp-item {
        display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer;
        border: 1px solid var(--sym-border-soft); border-radius: var(--sym-radius-sm);
        font-family: var(--vscode-editor-font-family); font-size: .86em;
        background: var(--sym-surface); transition: background 150ms ease, border-color 150ms ease, transform 120ms var(--sym-ease);
    }
    .mcp-item:hover {
        background: var(--sym-surface-2); transform: translateX(2px);
        border-color: color-mix(in srgb, var(--sym-accent) 40%, var(--sym-border-soft));
    }
    .mcp-item-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--sym-accent); flex: 0 0 auto; opacity: .8; }
    .mcp-empty { opacity: .55; font-size: .9em; padding: 8px 0; }

    /* ---- In-panel MCP add/edit modal ---------------------------------------- */
    .mcp-backdrop {
        position: fixed; inset: 0; z-index: 100;
        background: color-mix(in srgb, #000 50%, transparent);
        display: flex; align-items: flex-start; justify-content: center;
        padding: 56px 16px 16px; overflow: auto;
        animation: sym-fade 150ms var(--sym-ease);
    }
    .mcp-modal {
        width: 100%; max-width: 540px; box-sizing: border-box;
        background: var(--vscode-editor-background, var(--vscode-sideBar-background));
        border: 1px solid var(--sym-border);
        border-radius: var(--sym-radius); padding: 20px;
        box-shadow: 0 18px 50px color-mix(in srgb, #000 45%, transparent);
        display: flex; flex-direction: column; gap: 13px;
    }
    .mcp-modal::before {
        content: ""; display: block; height: 3px; margin: -20px -20px 2px;
        border-radius: var(--sym-radius) var(--sym-radius) 0 0;
        background: var(--sym-accent-grad);
    }
    .mcp-modal-title { font-size: 1.1em; font-weight: 700; }
    .mcp-form-error {
        font-size: .88em; color: var(--sym-bad); padding: 8px 11px; border-radius: var(--sym-radius-sm);
        background: color-mix(in srgb, var(--sym-bad) 14%, transparent);
        border: 1px solid color-mix(in srgb, var(--sym-bad) 35%, transparent);
    }
    .mcpf-field { display: flex; flex-direction: column; gap: 5px; }
    .mcpf-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; opacity: .6; }
    .mcpf-hint { font-size: .82em; opacity: .55; }
    .mcpf-input { width: 100%; box-sizing: border-box; }
    textarea.mcpf-input {
        font: inherit; color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--sym-border); border-radius: var(--sym-radius-sm); padding: 6px 9px;
        transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    textarea.mcpf-input:focus-visible {
        outline: none; border-color: var(--sym-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sym-accent) 25%, transparent);
    }
    .mcpf-area { min-height: 64px; resize: vertical; font-family: var(--vscode-editor-font-family); }
    .mcp-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

    /* ---- Small action buttons (preset/legacy) ------------------------------- */
    .btn-delete, .btn-edit {
        padding: 5px 9px; background: var(--sym-surface-2); color: var(--vscode-foreground);
        border: 1px solid var(--sym-border); border-radius: 6px;
    }
    .btn-delete:hover { background: color-mix(in srgb, var(--sym-bad) 18%, transparent); color: var(--sym-bad); border-color: color-mix(in srgb, var(--sym-bad) 40%, transparent); }
    .btn-edit:hover { background: var(--sym-surface); border-color: color-mix(in srgb, var(--sym-accent) 40%, var(--sym-border)); }

    .pref-block { padding: 13px 14px; display: flex; flex-direction: column; gap: 9px; }
    .pref-block .desc { opacity: .7; font-size: .9em; line-height: 1.5; }
    textarea.pref-text {
        font: inherit; color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--sym-border); border-radius: var(--sym-radius-sm);
        padding: 9px 11px; resize: vertical; min-height: 72px; width: 100%; box-sizing: border-box;
        transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    textarea.pref-text:focus-visible {
        outline: none; border-color: var(--sym-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--sym-accent) 25%, transparent);
    }
    input.exec { min-width: 220px; }

    .profile { display: inline-flex; align-items: center; gap: 8px; }
    .profile img { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; border: 1.5px solid color-mix(in srgb, var(--sym-accent) 50%, transparent); }
    .profile .uname { opacity: .9; font-weight: 500; }

    @media (max-width: 620px) {
        .pref-item { grid-template-columns: 1fr; gap: 10px; }
        .pref-item .ctl { justify-self: stretch; }
        nav { gap: 3px; padding: 8px 12px; }
        .page { padding: 0 12px; }
    }
    @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .row:hover, .card:hover, button:hover, nav .tab:hover { transform: none; }
    }
`;
