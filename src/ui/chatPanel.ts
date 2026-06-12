import * as vscode from "vscode";
import { AgentAdapter, AgentEvent, AgentSession, SessionStartOptions } from "../adapters/types";

/**
 * One webview panel hosting one dialogue with one agent session.
 * The webview is a thin renderer; all process state lives here.
 */
export class ChatPanel {
    private static panels = new Map<string, ChatPanel>();
    private session: AgentSession | undefined;
    private readonly panel: vscode.WebviewPanel;

    static open(
        context: vscode.ExtensionContext,
        adapter: AgentAdapter,
        options: SessionStartOptions,
        title: string,
    ): ChatPanel {
        const key = `${adapter.backend}:${options.resumeSessionId ?? Date.now()}`;
        const existing = ChatPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal();
            return existing;
        }
        const created = new ChatPanel(context, adapter, options, title, key);
        ChatPanel.panels.set(key, created);
        return created;
    }

    private constructor(
        context: vscode.ExtensionContext,
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        title: string,
        key: string,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            "symposium.chat",
            `${title} · ${adapter.backend}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = renderHtml(this.panel.webview);
        this.panel.onDidDispose(() => {
            this.session?.dispose();
            ChatPanel.panels.delete(key);
        }, undefined, context.subscriptions);

        this.panel.webview.onDidReceiveMessage((message) => {
            if (message.type === "send" && typeof message.text === "string") {
                this.sendUserMessage(message.text);
            } else if (message.type === "cancel") {
                this.session?.cancel();
            }
        }, undefined, context.subscriptions);

        this.post({ type: "meta", backend: adapter.backend, resumed: !!options.resumeSessionId });
    }

    private sendUserMessage(text: string): void {
        if (!this.session) {
            this.session = this.adapter.start(this.options);
            this.session.on("event", (event: AgentEvent) => this.post({ type: "event", event }));
        }
        this.post({ type: "user", text });
        this.session.send(text);
    }

    private post(message: unknown): void {
        void this.panel.webview.postMessage(message);
    }
}

function renderHtml(webview: vscode.Webview): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 0;
    }
    #log { flex: 1; overflow-y: auto; padding: 12px; }
    .msg { margin: 0 0 10px 0; white-space: pre-wrap; word-break: break-word; }
    .user { color: var(--vscode-textLink-foreground); }
    .tool { opacity: 0.7; font-style: italic; font-size: 0.9em; }
    .error { color: var(--vscode-errorForeground); }
    .meta { opacity: 0.55; font-size: 0.85em; }
    #bar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
    #input {
        flex: 1; resize: none; min-height: 36px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px;
        font-family: inherit;
    }
    button {
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border: none; border-radius: 4px; padding: 0 14px; cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<div id="log"></div>
<div id="bar">
    <textarea id="input" placeholder="Message the agent... (Enter sends, Shift+Enter newline)"></textarea>
    <button id="send">Send</button>
</div>
<script>
    const vscode = acquireVsCodeApi();
    const log = document.getElementById("log");
    const input = document.getElementById("input");

    function append(cls, text) {
        const el = document.createElement("div");
        el.className = "msg " + cls;
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el;
    }

    function send() {
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        vscode.postMessage({ type: "send", text });
    }

    document.getElementById("send").addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });

    window.addEventListener("message", ({ data }) => {
        if (data.type === "user") {
            append("user", "you: " + data.text);
        } else if (data.type === "meta") {
            append("meta", "backend: " + data.backend + (data.resumed ? " (resumed session)" : " (new session)"));
        } else if (data.type === "event") {
            const ev = data.event;
            if (ev.kind === "text") append("", ev.text);
            else if (ev.kind === "tool-start") append("tool", "⚙ " + ev.toolName + " " + (ev.detail || ""));
            else if (ev.kind === "error") append("error", "✖ " + ev.message);
            else if (ev.kind === "session") append("meta", "session " + ev.sessionId + (ev.model ? " · model " + ev.model : ""));
            else if (ev.kind === "turn-end") append("meta", "— turn end" + (ev.costUsd ? " · $" + ev.costUsd.toFixed(4) : "") + " —");
        }
    });
</script>
</body>
</html>`;
}
