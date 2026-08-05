import { chatStyles } from "./chatStyles";
import { chatClientJs } from "./chatClient";

/**
 * The chat DOM subtree — everything inside `<body>` except the client `<script>`.
 *
 * Shared by the VS Code webview (`renderHtml`) and the browser PWA
 * (`src/ui/pwaHtml.ts`) so the two never drift: both mount the identical set of
 * element ids that `src/ui/webview/dom.ts` resolves at load. Only the outer
 * shell (CSP/nonce vs manifest/external script) differs between the two hosts.
 */
export const chatBodyMarkup = /* html */ `<div id="root">
    <div id="bootState">
        <div class="bootLogo"><svg viewBox="0 0 24 24" fill="none"><rect x="1" y="1" width="15" height="10" rx="3" fill="white" fill-opacity="0.3"/><path d="M4 11 L2 15 L8 11 Z" fill="white" fill-opacity="0.3"/><rect x="8" y="11" width="15" height="10" rx="3" fill="white" fill-opacity="0.92"/><path d="M20 21 L22 24 L17 21 Z" fill="white" fill-opacity="0.92"/><circle cx="12" cy="16" r="1.3" fill="#7C3AED"/><circle cx="15.5" cy="16" r="1.3" fill="#4F46E5"/><circle cx="19" cy="16" r="1.3" fill="#3B82F6"/></svg></div>
        <div class="bootTitle">Symposium</div>
        <div id="bootSteps"></div>
        <div id="bootHint">Starting…</div>
    </div>
    <div id="progress"></div>
    <aside id="sessionsPane" data-zone="sessions">
        <div id="sessionsHeader" data-zone="sessions-header">
            <span>Sessions</span>
            <span>
                <button id="sessionRefreshBtn" class="iconBtn" title="Refresh sessions" aria-label="Refresh sessions"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.6 2.7v3.2h-3.2l1.2-1.2A4 4 0 1 0 12 8h1.3A5.3 5.3 0 1 1 12.5 4l1.1-1.3Z"/></svg></button>
                <button id="sessionFilterBtn" class="iconBtn" title="Filter sessions" aria-label="Filter sessions"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3.75A.75.75 0 0 1 2.75 3h10.5a.75.75 0 0 1 .53 1.28L10 8.06v3.19a.75.75 0 0 1-.33.62l-2 1.33A.75.75 0 0 1 6.5 12.6V8.06L2.22 4.28A.75.75 0 0 1 2 3.75Z"/></svg></button>
                <button id="newSessionBtn" class="iconBtn" title="New session" aria-label="New session"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.5.5 0 0 1 .5.5V7.5h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6V1.5A.5.5 0 0 1 8 1Z"/></svg></button>
                <button id="archToggle" class="iconBtn" title="Show/hide archived" aria-label="Show/hide archived"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M14 2H2a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1ZM2 6v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6H2Zm4 2h4a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1Z"/></svg></button>
            </span>
        </div>
        <input id="sessionSearch" class="sessionSearch" type="search" placeholder="Search sessions…" aria-label="Search sessions" />
        <div id="sessionsList" data-zone="sessions-list"></div>
        <div id="accountFooter" data-zone="account" title="Sufficit account"></div>
    </aside>
    <div id="resizer" title="Drag to resize"></div>
    <main id="chatCol">
        <div id="chatHeader" data-zone="header">
            <button id="listToggle" class="iconBtn" title="Sessions" aria-label="Sessions"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v1H2V4Zm0 4h12v1H2V8Zm0 4h12v1H2v-1Z"/></svg></button>
            <span id="chatTitle"></span>
            <span id="agentBadge" class="agentBadge" style="display:none" title="Agent driving this session"></span>
            <button id="switchAgentBtn" class="iconBtn" title="Switch adapter" aria-label="Switch adapter" style="display:none">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.5 1 6l3.5 3.5V7H10V5H4.5V2.5Zm7 4L15 10l-3.5 3.5V11H6V9h5.5V6.5Z"/></svg>
            </button>
            <button id="copySessionBtn" class="iconBtn" title="Copy session id + title" aria-label="Copy session id and title" style="display:none">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 2h6a1 1 0 0 1 1 1v8h-1V3H5V2ZM3 4h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 1v8h6V5H3Z"/></svg>
            </button>
            <button id="headerSessionsBtn" class="iconBtn" title="Open session" aria-label="Open session">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 5.2V2.4m0 0H5M2.2 2.4l1.9 1.8A5.4 5.4 0 1 1 2.7 9"/><path d="M8 4.8V8l2.2 1.4"/></svg>
            </button>
            <button id="headerNewSessionBtn" class="iconBtn" title="New session" aria-label="New session">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M2.5 3.5h7a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6l-2.5 2v-2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z"/><path d="M12 1v5M9.5 3.5h5" stroke-width="1.3" stroke-linecap="round"/></svg>
            </button>
            <button id="remoteAccessBtn" class="iconBtn" title="Remote access — scan QR to open on your phone" aria-label="Remote access">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1H2a1 1 0 0 0-1 1v4.5a1 1 0 0 0 1 1h4.5a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1Zm0 1v4.5H2V2h4.5ZM4 3.5h.5v.5H4v-.5ZM14 1H9.5a1 1 0 0 0-1 1v4.5a1 1 0 0 0 1 1H14a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1Zm0 1v4.5H9.5V2H14Zm-2 1.5h.5v.5H12v-.5ZM6.5 8.5H2a1 1 0 0 0-1 1V14a1 1 0 0 0 1 1h4.5a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1Zm0 1V14H2V9.5h4.5ZM4 11h.5v.5H4V11ZM9 8.5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0v-6Zm5.5 0a.5.5 0 0 0-1 0V11H12a.5.5 0 0 0 0 1h1.5v3a.5.5 0 0 0 1 0v-6.5Z"/></svg>
            </button>
        </div>
        <div id="logWrap" data-zone="chat">
            <div id="log" data-zone="chat-log"><div id="logBody"></div></div>
            <div id="emptyState" data-zone="empty-state">
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
            <div id="agentPicker">
                <div class="apTitle" id="agentPickerTitle">Which agent joins the symposium?</div>
                <div class="apList" id="agentPickerList"></div>
            </div>
            <button id="scrollBottom" title="Go to the bottom" aria-label="Go to the bottom"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 13.5 13 8.5h-3v-6H6v6H3L8 13.5Z"/></svg></button>
        </div>
        <div id="queued" data-zone="queued"></div>
        <div id="panelTabs" data-zone="panel-tabs"></div>
        <div id="panelBody" data-zone="panel-body">
            <div id="plan"></div>
            <div id="guardrails"></div>
            <div id="tasks"></div>
            <div id="changedFiles"></div>
            <div id="attachedPanel"><div class="apHead">Attached to context</div><div id="chips"></div></div>
        </div>
        <div id="composer" data-zone="composer">
            <div id="slash"></div>
            <div id="composerBlockedNotice" role="status" aria-live="polite">
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.25 13 3v3.75c0 3.35-2.02 6.4-5 7.75-2.98-1.35-5-4.4-5-7.75V3l5-1.75Zm0 1.6L4.5 4.07v2.68c0 2.55 1.42 4.96 3.5 6.12 2.08-1.16 3.5-3.57 3.5-6.12V4.07L8 2.85ZM7.25 5h1.5v4h-1.5V5Zm0 5h1.5v1.5h-1.5V10Z"/></svg>
                <span></span>
            </div>
            <textarea id="input" data-zone="input" placeholder="Ask the agent…  (Enter sends · Shift+Enter newline)"></textarea>
            <div id="toolbar" data-zone="toolbar">
                <div id="toolbarControls">
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
                </div>
                <button id="cancelEdit" class="editCancel" title="Cancel edit" aria-label="Cancel edit" style="display:none">
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="m4.1 3.4 4 4 4-4 .7.7-4 4 4 4-.7.7-4-4-4 4-.7-.7 4-4-4-4 .7-.7Z"/></svg>
                    <span id="cancelEditLabel" class="editCancelLabel">Cancel edit</span>
                </button>
                <select id="sendMode" style="display:none">
                    <option value="queue">Queue</option>
                    <option value="redirect">Redirect</option>
                    <option value="steer">Steer</option>
                </select>
                <div id="sendGroup" data-zone="send-group">
                    <button id="stopBtn" title="Stop the running turn (Esc)" aria-label="Stop the running turn" style="display:none"><svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg></button>
                    <button id="mic" title="Voice input" aria-label="Voice input" style="display:none"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0V4a2.5 2.5 0 0 0-2.5-2.5Z"/><path d="M4.75 7.5a.75.75 0 0 1 .75.75 2.5 2.5 0 0 0 5 0 .75.75 0 0 1 1.5 0 4.002 4.002 0 0 1-3.25 3.93V14h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-1.82A4.002 4.002 0 0 1 4 8.25a.75.75 0 0 1 .75-.75Z"/></svg></button>
                    <button id="send" title="Send (Enter)" aria-label="Send (Enter)"><span id="sendIcon"></span></button>
                    <button id="sendCaret" title="Send mode" aria-label="Send mode"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4H4Z"/></svg></button>
                </div>
            </div>
        </div>
        <footer id="statusbar" data-zone="footer"></footer>
    </main>
</div>
<div id="ctxMenu"></div>
<div id="tip" role="tooltip"></div>
<div id="toast" role="status" aria-live="polite"></div>`;

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
${chatBodyMarkup}
<script nonce="${nonce}">
${chatClientJs}
</script>
</body>
</html>`;
}
