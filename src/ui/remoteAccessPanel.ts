import * as vscode from "vscode";
import qrcode from "qrcode-generator";
import { RemoteBridge } from "../api/bridge";
import { HubClient } from "../sync/hubClient";
import { getJoinedHostname } from "../net/tailnet";

/**
 * "Symposium: Enable Remote Access" surface — the discoverable entry point for the bridge
 * PWA. `symposium.bridge.enabled` already exists as a raw setting (off by default) but was
 * only reachable by knowing to search VS Code's generic Settings UI; this panel is the
 * friendly front door: it flips that setting on, shows a scannable QR + copyable URL, and
 * says plainly which machine (if any) is currently serving remote access — Symposium's
 * bridge floats to whichever machine most recently joined the tailnet (net/tailnet.ts), so
 * that's not always obvious otherwise.
 */
export class RemoteAccessPanel {
    private static current: RemoteAccessPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private shareUrl: string | undefined;

    static async show(context: vscode.ExtensionContext, bridge: RemoteBridge): Promise<void> {
        if (RemoteAccessPanel.current) {
            RemoteAccessPanel.current.panel.reveal();
        } else {
            RemoteAccessPanel.current = new RemoteAccessPanel(context, bridge);
        }
        await RemoteAccessPanel.current.render(bridge);
    }

    private constructor(context: vscode.ExtensionContext, bridge: RemoteBridge) {
        this.panel = vscode.window.createWebviewPanel(
            "symposium.remoteAccess",
            "Symposium: Remote Access",
            vscode.ViewColumn.Active,
            { enableScripts: true },
        );
        this.panel.webview.onDidReceiveMessage((m) => {
            if (m?.type === "copy" && this.shareUrl) {
                void vscode.env.clipboard.writeText(this.shareUrl);
                void vscode.window.showInformationMessage("Symposium: remote-access URL copied.");
            }
        }, undefined, context.subscriptions);
        this.panel.onDidDispose(() => {
            RemoteAccessPanel.current = undefined;
            bridge.setRelayUrlCallback(() => undefined);   // stop refreshing on dispose
        }, undefined, context.subscriptions);
        // Re-render the QR when the relay URL arrives (async WS handshake may
        // complete after the panel first opened with a tailnet fallback URL).
        bridge.setRelayUrlCallback(() => {
            if (RemoteAccessPanel.current === this) {
                void this.render(bridge);
            }
        });
        void bridge; // referenced only for the constructor signature symmetry with render()
    }

    private async render(bridge: RemoteBridge): Promise<void> {
        const html = await buildHtml(bridge);
        this.shareUrl = html.shareUrl;
        this.panel.webview.html = html.body;
    }
}

async function buildHtml(bridge: RemoteBridge): Promise<{ body: string; shareUrl: string | undefined }> {
    const conn = bridge.getConnection();
    if (!conn) {
        return { shareUrl: undefined, body: page(`<p>Remote bridge is not running yet. If you just enabled it, wait a moment and reopen this panel — or run <b>Symposium: Restart Remote Bridge</b>.</p>`) };
    }

    const bound = new URL(conn.url);
    const thisHostname = getJoinedHostname();
    // Prefer the Sufficit relay public URL (works from any device, no app) over
    // the tailnet hostname (needs the Tailscale app on the client).
    const relayUrl = bridge.getRelayPublicUrl();
    const shareUrl = relayUrl
        ? `${relayUrl}&app=pwa&token=${encodeURIComponent(conn.token)}`
        : `${conn.https ? "https" : "http"}://${thisHostname ?? bound.hostname}:${bound.port}/pwa/?token=${encodeURIComponent(conn.token)}`;

    let statusLine: string;
    if (relayUrl) {
        statusLine = `<p class="ok">Connected via Sufficit relay — this URL works from <b>any device</b> (scan the QR with a phone, no app needed).</p>`;
    } else if (!thisHostname) {
        statusLine = `<p class="warn">Not joined to the Sufficit tailnet yet — this URL only works from ${escapeHtml(bound.hostname)} itself (log in to Sufficit to join automatically).</p>`;
    } else {
        const hub = new HubClient();
        const remote = await hub.resolveSymposiumRemoteUrl().catch(() => null);
        if (!remote?.online) {
            statusLine = `<p class="ok">This machine (${escapeHtml(thisHostname)}) is the one that will serve remote access.</p>`;
        } else if (remote.hostname === thisHostname) {
            statusLine = `<p class="ok">This machine is currently serving remote access.</p>`;
        } else {
            statusLine = `<p class="warn">Remote access is currently active on a different machine (${escapeHtml(remote.hostname ?? "unknown")}) — opening this URL takes over.</p>`;
        }
    }
    if (!conn.https) {
        statusLine += `<p class="warn">Serving plain HTTP (no TLS cert available) — a phone's PWA install/offline features need HTTPS to work; the URL below will still work in a regular browser tab.</p>`;
    }

    const qr = qrcode(0, "M");
    qr.addData(shareUrl);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });

    return {
        shareUrl,
        body: page(`
            ${statusLine}
            <div class="qr">${svg}</div>
            <div class="urlRow">
                <code id="url">${escapeHtml(shareUrl)}</code>
                <button id="copyBtn">Copy</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                document.getElementById("copyBtn").addEventListener("click", () => vscode.postMessage({ type: "copy" }));
            </script>
        `),
    };
}

function page(inner: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }
    .qr { max-width: 260px; margin: 16px 0; }
    .qr svg { width: 100%; height: auto; }
    .urlRow { display: flex; align-items: center; gap: 8px; }
    code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.17)); padding: 4px 8px; border-radius: 4px; word-break: break-all; }
    button { cursor: pointer; }
    .warn { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
    .ok { color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground)); }
</style>
</head>
<body>${inner}</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
