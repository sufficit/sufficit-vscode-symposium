/**
 * Symposium configuration webview styles — base layer.
 *
 * Design tokens, layout primitives (body/header/tabs/rows/buttons/inputs) shared
 * across every config tab. Split out of configStyles.ts so that file stays under
 * the 400-line cap; configStyles.ts concatenates base + views. Injected verbatim
 * into the panel's inline <style> (CSP allows 'unsafe-inline' styles only).
 */

export const configStylesBase = /* css */ `
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
`;
