import { chatStyles } from "./chatStyles";
import { chatClientJs } from "./chatClient";

/**
 * Shared chat webview markup for the sidebar view and the editor panel.
 *
 * Master-detail layout mirroring the built-in Chat sessions viewer: a
 * sessions list pane beside the conversation, shown automatically when the
 * surface is wide enough and collapsible behind a toggle when narrow. The
 * pane side (left/right) comes from the `meta` message.
 */
export function renderHtml(): string {
    // Nonce required by VSCode 1.90+ webview CSP enforcement (unsafe-inline alone is blocked).
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const csp = `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${chatStyles}
</style>
</head>
<body>
<div id="root">
    <div id="bootState">
        <div class="bootLogo"><svg viewBox="0 0 24 24" fill="none"><rect x="1" y="1" width="15" height="10" rx="3" fill="white" fill-opacity="0.3"/><path d="M4 11 L2 15 L8 11 Z" fill="white" fill-opacity="0.3"/><rect x="8" y="11" width="15" height="10" rx="3" fill="white" fill-opacity="0.92"/><path d="M20 21 L22 24 L17 21 Z" fill="white" fill-opacity="0.92"/><circle cx="12" cy="16" r="1.3" fill="#7C3AED"/><circle cx="15.5" cy="16" r="1.3" fill="#4F46E5"/><circle cx="19" cy="16" r="1.3" fill="#3B82F6"/></svg></div>
        <div class="bootTitle">Symposium</div>
        <div id="bootSteps"></div>
        <div id="bootHint">Starting…</div>
    </div>
    <div id="progress"></div>
    <aside id="sessionsPane">
        <div id="sessionsHeader">
            <span>Sessions</span>
            <span>
                <button id="newSessionBtn" class="iconBtn" title="New session" aria-label="New session"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.5.5 0 0 1 .5.5V7.5h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6V1.5A.5.5 0 0 1 8 1Z"/></svg></button>
                <button id="archToggle" class="iconBtn" title="Show/hide archived" aria-label="Show/hide archived"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M14 2H2a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1ZM2 6v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6H2Zm4 2h4a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1Z"/></svg></button>
            </span>
        </div>
        <div id="sessionsList"></div>
        <div id="accountFooter" title="Sufficit account"></div>
    </aside>
    <div id="resizer" title="Drag to resize"></div>
    <main id="chatCol">
        <div id="chatHeader">
            <button id="listToggle" class="iconBtn" title="Sessions" aria-label="Sessions"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v1H2V4Zm0 4h12v1H2V8Zm0 4h12v1H2v-1Z"/></svg></button>
            <span id="chatTitle"></span>
            <button id="switchAgentBtn" class="iconBtn" title="Switch to another model" aria-label="Switch to another model" style="display:none">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.5 1 6l3.5 3.5V7H10V5H4.5V2.5Zm7 4L15 10l-3.5 3.5V11H6V9h5.5V6.5Z"/></svg>
            </button>
            <button id="copySessionBtn" class="iconBtn" title="Copy session id + title" aria-label="Copy session id and title" style="display:none">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 2h6a1 1 0 0 1 1 1v8h-1V3H5V2ZM3 4h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 1v8h6V5H3Z"/></svg>
            </button>
        </div>
        <div id="logWrap">
            <div id="log"></div>
            <div id="emptyState">
                <div class="esLogo"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 1.5h1V3H11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5V1.5ZM6 6.5A1 1 0 1 0 6 8.5 1 1 0 0 0 6 6.5Zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM1 6h1v4H1V6Zm13 0h1v4h-1V6Z"/></svg></div>
                <div class="esTitle">Symposium</div>
                <div class="esHint">Type below to start a conversation.</div>
                <button class="esCta" id="emptyNewSession"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.5.5 0 0 1 .5.5V7.5h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6V1.5A.5.5 0 0 1 8 1Z"/></svg>New conversation</button>
                <button class="esBootstrap" id="bootstrapLink" style="display:none" title="Open the workspace bootstrap file"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L9.5 1ZM9 5V2l3 3H9Z"/></svg><span class="lbl"></span></button>
            </div>
            <div id="loadingState">
                <div class="ldLogo"><svg viewBox="0 0 24 24" fill="none"><rect x="1" y="1" width="15" height="10" rx="3" fill="white" fill-opacity="0.3"/><path d="M4 11 L2 15 L8 11 Z" fill="white" fill-opacity="0.3"/><rect x="8" y="11" width="15" height="10" rx="3" fill="white" fill-opacity="0.92"/><path d="M20 21 L22 24 L17 21 Z" fill="white" fill-opacity="0.92"/><circle cx="12" cy="16" r="1.3" fill="#7C3AED"/><circle cx="15.5" cy="16" r="1.3" fill="#4F46E5"/><circle cx="19" cy="16" r="1.3" fill="#3B82F6"/></svg></div>
                <div class="ldName">Symposium</div>
                <div class="ldSub"><span class="spinner"></span><span id="loadingText">Loading session…</span></div>
            </div>
            <button id="scrollBottom" title="Go to the bottom" aria-label="Go to the bottom"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 13.5 13 8.5h-3v-6H6v6H3L8 13.5Z"/></svg></button>
        </div>
        <div id="queued"></div>
        <div id="plan"></div>
        <div id="panelBody">
            <div id="guardrails"></div>
            <div id="tasks"></div>
            <div id="changedFiles"></div>
            <div id="attachedPanel"><div class="apHead">Attached to context</div><div id="chips"></div></div>
        </div>
        <div id="panelTabs"></div>
        <div id="composer">
            <div id="slash"></div>
            <textarea id="input" placeholder="Ask the agent…  (Enter sends · Shift+Enter newline)"></textarea>
            <div id="toolbar">
                <button id="addContext" class="iconBtn" title="Attach files" aria-label="Attach files">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.5.5 0 0 1 .5.5V7.5h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6V1.5A.5.5 0 0 1 8 1Z"/></svg>
                </button>
                <button id="addBrowserPage" class="iconBtn" title="Attach the browser page to the context" aria-label="Attach the browser page to the context">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM2 8h2.05c.08-1.4.36-2.66.78-3.6A6 6 0 0 0 2 8Zm2.05 1H2a6 6 0 0 0 2.83 3.6c-.42-.94-.7-2.2-.78-3.6Zm1 0c.1 1.6.46 2.9.9 3.66.2.34.38.5.55.6V9H5.05Zm0-1H7.5V4.74c-.17.1-.36.26-.55.6-.44.76-.8 2.06-.9 3.66ZM8.5 4.74V8h2.45c-.1-1.6-.46-2.9-.9-3.66-.2-.34-.38-.5-.55-.6ZM11.95 8H14a6 6 0 0 0-2.83-3.6c.42.94.7 2.2.78 3.6Zm0 1c-.08 1.4-.36 2.66-.78 3.6A6 6 0 0 0 14 9h-2.05ZM8.5 9v4.26c.17-.1.36-.26.55-.6.44-.76.8-2.06.9-3.66H8.5Z"/></svg>
                </button>
                <button id="configBtn" class="iconBtn" title="Tools & configuration" aria-label="Tools & configuration">
                    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3a2 2 0 0 1 3.9-.5H14v1H7.9A2 2 0 0 1 4 3Zm-2 .5h1.2a2 2 0 0 0 0-1H2v1Zm6 4.5a2 2 0 0 1 3.9-.5H14v1h-2.1A2 2 0 0 1 8 8Zm-6 .5h4.2a2 2 0 0 0 0-1H2v1Zm2 4.5a2 2 0 0 1 3.9-.5H14v1H7.9A2 2 0 0 1 4 13Zm-2 .5h1.2a2 2 0 0 0 0-1H2v1Z"/></svg>
                </button>
                <button id="modelPicker" class="ctl menubtn" style="display:none" title="Model — change anytime; applies to the next message" aria-label="Model — change anytime; applies to the next message"><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                <button id="reasoningPicker" class="ctl menubtn" style="display:none" title="Reasoning effort — change anytime; applies to the next message" aria-label="Reasoning effort"><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                <button id="presencePicker" class="ctl menubtn" title="Presence — can be changed any time" aria-label="Presence — can be changed any time"><span class="picon"></span><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                <button id="execPicker" class="ctl menubtn" style="display:none" title="Shell execution display" aria-label="Shell execution display"><span class="lbl"></span><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                <span id="status"></span>
                <span class="grow"></span>
                <select id="sendMode" style="display:none">
                    <option value="queue">Queue</option>
                    <option value="steer">Steer</option>
                </select>
                <div id="sendGroup">
                    <button id="stopBtn" title="Stop the running turn (Esc)" aria-label="Stop the running turn" style="display:none"><svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg></button>
                    <button id="send" title="Send (Enter)" aria-label="Send (Enter)"><span id="sendIcon"></span></button>
                    <button id="sendCaret" title="Send mode" aria-label="Send mode"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                </div>
            </div>
        </div>
        <footer id="statusbar"></footer>
    </main>
</div>
<div id="ctxMenu"></div>
<div id="tip" role="tooltip"></div>
<div id="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}">
${chatClientJs}
</script>
</body>
</html>`;
}
