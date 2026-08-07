// ---- theme (the webview CSS reads ~78 --vscode-* vars the browser doesn't set) ----
// Dark is the default; light overrides only what flips; "auto" follows the OS.
const THEME_CSS = `
:root{
  color-scheme:dark;
  --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --vscode-font-size:13px;
  --vscode-editor-font-family:ui-monospace,"Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
  --vscode-editor-font-size:13px;
  --vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;
  --vscode-descriptionForeground:#9d9d9d;--vscode-disabledForeground:#888888;--vscode-errorForeground:#f48771;
  --vscode-focusBorder:#007fd4;--vscode-widget-border:#303031;--vscode-panel-border:#2b2b2b;
  --vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#ffffff;
  --vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#1177bb;
  --vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ffffff;--vscode-button-secondaryHoverBackground:#45494e;
  --vscode-input-background:#3c3c3c;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-input-placeholderForeground:#a6a6a6;
  --vscode-inputValidation-errorBackground:#5a1d1d;
  --vscode-list-activeSelectionBackground:#094771;--vscode-list-activeSelectionForeground:#ffffff;--vscode-list-hoverBackground:#2a2d2e;
  --vscode-menu-background:#252526;--vscode-menu-foreground:#cccccc;--vscode-menu-border:#454545;
  --vscode-menu-selectionBackground:#094771;--vscode-menu-selectionForeground:#ffffff;--vscode-menu-separatorBackground:#454545;
  --vscode-editorWidget-background:#252526;--vscode-editor-inactiveSelectionBackground:#3a3d41;--vscode-editorWarning-foreground:#cca700;
  --vscode-editorHoverWidget-background:#252526;--vscode-editorHoverWidget-border:#454545;--vscode-editorHoverWidget-foreground:#cccccc;
  --vscode-editorSuggestWidget-background:#252526;--vscode-editorSuggestWidget-border:#454545;--vscode-editorSuggestWidget-foreground:#cccccc;--vscode-editorSuggestWidget-selectedBackground:#094771;
  --vscode-editorLineNumber-foreground:#858585;
  --vscode-notifications-background:#252526;--vscode-notifications-border:#303031;--vscode-notifications-foreground:#cccccc;
  --vscode-textLink-foreground:#3794ff;--vscode-textLink-activeForeground:#3794ff;
  --vscode-textBlockQuote-background:#7f7f7f1a;--vscode-textBlockQuote-border:#007acc80;
  --vscode-textCodeBlock-background:#0a0a0a66;--vscode-textPreformat-background:#0a0a0a66;--vscode-textPreformat-foreground:#d7ba7d;
  --vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-icon-foreground:#c5c5c5;
  --vscode-scrollbarSlider-background:#79797966;--vscode-scrollbarSlider-hoverBackground:#646464b3;--vscode-scrollbarSlider-activeBackground:#bfbfbf66;
  --vscode-progressBar-background:#0e70c0;
  --vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-red:#f14c4c;
  --vscode-chat-avatarBackground:#1f1f1f;--vscode-chat-requestBackground:#2a2a2a80;--vscode-chat-requestBorder:#ffffff1a;
  --vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-deletedResourceForeground:#c74e39;--vscode-gitDecoration-stageModifiedResourceForeground:#e2c08d;
  --vscode-testing-iconPassed:#73c991;
  --vscode-statusBarItem-errorBackground:#c72e0f;--vscode-statusBarItem-errorForeground:#ffffff;--vscode-statusBarItem-warningBackground:#7a6400;--vscode-statusBarItem-warningForeground:#ffffff;
}
:root[data-theme="light"]{
  color-scheme:light;
  --vscode-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-editor-foreground:#3b3b3b;
  --vscode-descriptionForeground:#767676;--vscode-disabledForeground:#a0a0a0;--vscode-errorForeground:#e51400;
  --vscode-focusBorder:#0090f1;--vscode-widget-border:#d4d4d4;--vscode-panel-border:#e5e5e5;
  --vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;
  --vscode-button-background:#005fb8;--vscode-button-hoverBackground:#0258a8;
  --vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-button-secondaryHoverBackground:#cccccc;
  --vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-input-placeholderForeground:#767676;
  --vscode-list-activeSelectionBackground:#005fb8;--vscode-list-hoverBackground:#f0f0f0;
  --vscode-menu-background:#ffffff;--vscode-menu-foreground:#3b3b3b;--vscode-menu-border:#cecece;--vscode-menu-selectionBackground:#005fb8;
  --vscode-editorWidget-background:#f8f8f8;--vscode-editorHoverWidget-background:#f8f8f8;--vscode-editorHoverWidget-foreground:#3b3b3b;
  --vscode-editorSuggestWidget-background:#f8f8f8;--vscode-editorSuggestWidget-foreground:#3b3b3b;
  --vscode-notifications-background:#ffffff;--vscode-notifications-foreground:#3b3b3b;--vscode-icon-foreground:#3b3b3b;
  --vscode-textLink-foreground:#005fb8;--vscode-textLink-activeForeground:#005fb8;
  --vscode-textCodeBlock-background:#0000000a;--vscode-textPreformat-background:#0000000a;--vscode-textPreformat-foreground:#a31515;
  --vscode-toolbar-hoverBackground:#0000000d;--vscode-chat-avatarBackground:#f8f8f8;--vscode-chat-requestBackground:#f0f0f080;--vscode-chat-requestBorder:#0000001a;
}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]):not([data-theme="light"]){color-scheme:light;
  --vscode-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#767676;
  --vscode-widget-border:#d4d4d4;--vscode-panel-border:#e5e5e5;--vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;
  --vscode-button-background:#005fb8;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;
  --vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-input-placeholderForeground:#767676;
  --vscode-list-activeSelectionBackground:#005fb8;--vscode-list-hoverBackground:#f0f0f0;--vscode-menu-background:#ffffff;--vscode-menu-foreground:#3b3b3b;
  --vscode-menu-border:#cecece;--vscode-editorWidget-background:#f8f8f8;--vscode-notifications-background:#ffffff;--vscode-notifications-foreground:#3b3b3b;
  --vscode-icon-foreground:#3b3b3b;--vscode-textLink-foreground:#005fb8;--vscode-textCodeBlock-background:#0000000a;--vscode-chat-requestBackground:#f0f0f080;}}
#pwaTheme-btn{position:fixed;top:8px;right:64px;z-index:99998;display:none;width:30px;height:26px;border-radius:7px;font-size:13px;
  background:rgba(0,0,0,.35);border:1px solid rgba(128,128,128,.3);color:var(--vscode-foreground,#ccc);cursor:pointer;}
`;

const LS_THEME = "symposium.pwa.theme"; // "dark" | "light" | "" (auto)

function applyThemeMode(mode: string): void {
    const root = document.documentElement;
    if (mode === "dark" || mode === "light") {
        root.setAttribute("data-theme", mode);
    } else {
        root.removeAttribute("data-theme");
    }
    try {
        localStorage.setItem(LS_THEME, mode);
    } catch {
        /* ignore */
    }
    const btn = document.getElementById("pwaTheme-btn");
    if (btn) {
        btn.textContent = mode === "dark" ? "🌙" : mode === "light" ? "☀️" : "🌓";
        btn.title = `Tema: ${mode || "automático"}`;
    }
}

let themeBuilt = false;
export function applyTheme(): void {
    if (themeBuilt) {
        return;
    }
    themeBuilt = true;
    const style = document.createElement("style");
    style.id = "pwaTheme";
    style.textContent = THEME_CSS;
    document.head.appendChild(style);
    let saved = "";
    try {
        saved = localStorage.getItem(LS_THEME) ?? "";
    } catch {
        /* ignore */
    }
    applyThemeMode(saved);
    // Toggle button (auto → dark → light → auto), shown once logged in.
    if (!document.getElementById("pwaTheme-btn")) {
        const btn = document.createElement("button");
        btn.id = "pwaTheme-btn";
        btn.type = "button";
        btn.addEventListener("click", () => {
            const cur = localStorage.getItem(LS_THEME) ?? "";
            const next = cur === "" ? "dark" : cur === "dark" ? "light" : "";
            applyThemeMode(next);
        });
        document.body.appendChild(btn);
        applyThemeMode(saved); // set icon
    }
}
