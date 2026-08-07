import * as vscode from "vscode";
import qrcode from "qrcode-generator";
import { RemoteBridge } from "../api/bridge";
import { discoverAddresses, buildUrl, DiscoveredIp } from "../net/ipDiscovery";
import { discoverUpnpGateway, addPortMapping, UpnpPortMapping } from "../net/upnp";
import { getJoinedHostname, checkTailscaleStatus } from "../net/tailnet";

/**
 * Remote-access panel: shows all the ways a client can reach this Symposium
 * bridge — discovered IPs (public via UPnP, LAN, Tailscale, IPv6) with a QR
 * for each, plus a one-click UPnP port-forward button and a VPN setup wizard.
 *
 * The user scans the QR that matches their network (public for internet,
 * LAN for same wifi, etc) and opens the PWA on their device.
 */

interface PanelState {
    addresses: DiscoveredIp[];
    upnpMapping: UpnpPortMapping | null;
    upnpBusy: boolean;
    vpnHostname: string | undefined;
    vpnConnected: boolean;
}

export class RemoteAccessPanel {
    private static current: RemoteAccessPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private state: PanelState = {
        addresses: [],
        upnpMapping: null,
        upnpBusy: false,
        vpnHostname: undefined,
        vpnConnected: false,
    };
    private bridge: RemoteBridge;

    static async show(context: vscode.ExtensionContext, bridge: RemoteBridge): Promise<void> {
        if (RemoteAccessPanel.current) {
            RemoteAccessPanel.current.panel.reveal();
        } else {
            RemoteAccessPanel.current = new RemoteAccessPanel(context, bridge);
        }
        await RemoteAccessPanel.current.refresh();
    }

    private constructor(context: vscode.ExtensionContext, bridge: RemoteBridge) {
        this.bridge = bridge;
        this.panel = vscode.window.createWebviewPanel(
            "symposium.remoteAccess",
            "Symposium: Remote Access",
            vscode.ViewColumn.Active,
            { enableScripts: true },
        );
        this.panel.webview.onDidReceiveMessage(
            async (m) => {
                if (m?.type === "refresh") {
                    await this.refresh();
                } else if (m?.type === "upnp") {
                    await this.tryUpnp();
                } else if (m?.type === "bind-all") {
                    await this.toggleBindAll();
                } else if (m?.type === "copy" && m.url) {
                    void vscode.env.clipboard.writeText(m.url);
                }
            },
            undefined,
            context.subscriptions,
        );
        this.panel.onDidDispose(
            () => {
                RemoteAccessPanel.current = undefined;
            },
            undefined,
            context.subscriptions,
        );
        // Auto-refresh when relay URL changes
        bridge.setRelayUrlCallback(() => {
            if (RemoteAccessPanel.current === this) {
                void this.refresh();
            }
        });
    }

    private async refresh(): Promise<void> {
        const conn = this.bridge.getConnection();
        if (!conn) {
            this.panel.webview.html = this.renderEmpty();
            return;
        }
        const port = new URL(conn.url).port || "47600";
        const vpnHostname = getJoinedHostname() ?? (await this.getTailscaleHostname());
        const addresses = await discoverAddresses(Number(port), vpnHostname ?? undefined);
        this.state.addresses = addresses;
        this.state.vpnHostname = vpnHostname;
        this.state.vpnConnected = !!vpnHostname;
        this.panel.webview.html = this.renderHtml(conn);
    }

    private async getTailscaleHostname(): Promise<string | undefined> {
        const ts = await checkTailscaleStatus();
        if (ts?.BackendState === "Running" && ts.Self?.HostName) {
            return ts.Self.HostName;
        }
        return undefined;
    }

    private async tryUpnp(): Promise<void> {
        this.state.upnpBusy = true;
        this.panel.webview.html = this.renderHtml(this.bridge.getConnection()!);
        const port = Number(new URL(this.bridge.getConnection()!.url).port || "47600");
        const lanIp = this.state.addresses.find((a) => a.source === "lan")?.address ?? "0.0.0.0";
        const device = await discoverUpnpGateway(5000);
        if (!device) {
            vscode.window.showWarningMessage(
                "UPnP: no router found. The router may not support UPnP, or it may be disabled.",
            );
            this.state.upnpBusy = false;
            this.panel.webview.html = this.renderHtml(this.bridge.getConnection()!);
            return;
        }
        const mapping = await addPortMapping(device, lanIp, port);
        this.state.upnpBusy = false;
        if (mapping) {
            this.state.upnpMapping = mapping;
            vscode.window.showInformationMessage(
                `UPnP: port ${mapping.externalPort} opened on ${mapping.externalIp}.`,
            );
        } else {
            vscode.window.showWarningMessage("UPnP: failed to open port. Check router settings.");
        }
        this.panel.webview.html = this.renderHtml(this.bridge.getConnection()!);
    }

    private isBindAll(): boolean {
        return (
            vscode.workspace
                .getConfiguration("symposium.bridge")
                .get<string>("host", "127.0.0.1") === "0.0.0.0"
        );
    }

    private async toggleBindAll(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("symposium.bridge");
        const current = cfg.get<string>("host", "127.0.0.1");
        const newHost = current === "0.0.0.0" ? "127.0.0.1" : "0.0.0.0";
        await cfg.update("host", newHost, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
            newHost === "0.0.0.0"
                ? "Bridge: now listening on all interfaces (0.0.0.0). Accessible from LAN/public."
                : "Bridge: listening on localhost only (127.0.0.1).",
        );
        // Wait for bridge restart, then refresh
        await new Promise((r) => setTimeout(r, 2000));
        await this.refresh();
    }

    private renderEmpty(): string {
        return `<body style="font-family:sans-serif;padding:24px;color:#ccc;background:#1e1e2e">
            <h2>Remote Access</h2>
            <p>Bridge is not running yet. Click the QR button in the chat header to enable it.</p>
        </body>`;
    }

    private renderHtml(conn: { url: string; token: string; https: boolean }): string {
        const port = new URL(conn.url).port || "47600";
        const relayUrl = this.bridge.getRelayPublicUrl();

        // Build a connection URL for each discovered address
        const connUrls: { label: string; url: string; public: boolean; badge: string }[] = [];

        // Relay (if connected) — always first, always public
        if (relayUrl) {
            connUrls.push({
                label: "Sufficit Relay",
                url: `${relayUrl}&app=pwa&token=${encodeURIComponent(conn.token)}`,
                public: true,
                badge: "🌍",
            });
        }

        // UPnP mapping (if opened)
        if (this.state.upnpMapping) {
            const m = this.state.upnpMapping;
            connUrls.push({
                label: `UPnP ${m.externalIp}`,
                url: `http://${m.externalIp}:${m.externalPort}/pwa/?token=${encodeURIComponent(conn.token)}`,
                public: true,
                badge: "🌐",
            });
        }

        // Discovered IPs
        for (const ip of this.state.addresses) {
            const url = `${buildUrl(ip, Number(port))}/pwa/?token=${encodeURIComponent(conn.token)}`;
            connUrls.push({
                label: `${ip.label}: ${ip.address}`,
                url,
                public: ip.public,
                badge: ip.source === "tailscale" ? "🛡️" : ip.public ? "🌍" : "🏠",
            });
        }

        const urlCards = connUrls
            .map((c) => {
                const qr = qrcode(0, "M");
                qr.addData(c.url);
                qr.make();
                const svg = qr.createSvgTag({ cellSize: 3, margin: 1, scalable: true });
                return `
                <div class="card">
                    <div class="cardHead">
                        <span class="badge">${c.badge}</span>
                        <span class="label">${esc(c.label)}</span>
                        ${c.public ? '<span class="tag">public</span>' : '<span class="tag dim">LAN only</span>'}
                    </div>
                    <div class="qr">${svg}</div>
                    <div class="urlRow">
                        <code class="url">${esc(c.url.length > 60 ? c.url.slice(0, 57) + "..." : c.url)}</code>
                        <button class="copy" data-url="${esc(c.url)}">Copy</button>
                    </div>
                </div>`;
            })
            .join("");

        const vpnStatus = this.state.vpnConnected
            ? `<div class="status ok">✓ VPN: <b>${esc(this.state.vpnHostname || "connected")}</b></div>`
            : `<div class="status warn">⚠ VPN: not connected</div>`;

        const upnpBtn = this.state.upnpBusy
            ? '<button class="btn" disabled>Opening port...</button>'
            : this.state.upnpMapping
              ? `<div class="status ok">✓ UPnP: port ${this.state.upnpMapping.externalPort} on ${this.state.upnpMapping.externalIp}</div>`
              : '<button class="btn" id="upnpBtn">Open port via UPnP</button>';

        return `<html><head><meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { box-sizing: border-box; }
                body { font-family: var(--vscode-font-family, sans-serif); background: var(--vscode-editor-background, #1e1e2e); color: var(--vscode-foreground, #ccc); margin: 0; padding: 16px; }
                h2 { margin: 0 0 12px; font-size: 16px; }
                .grid { display: flex; flex-wrap: wrap; gap: 12px; }
                .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 12px; min-width: 200px; max-width: 260px; }
                .cardHead { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 12px; }
                .badge { font-size: 16px; }
                .label { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .tag { font-size: 9px; padding: 2px 6px; border-radius: 4px; background: rgba(74,222,128,0.2); color: #4ade80; }
                .tag.dim { background: rgba(148,163,184,0.15); color: #94a3b8; }
                .qr { display: flex; justify-content: center; margin: 4px 0; }
                .qr svg { width: 130px; height: 130px; }
                .urlRow { display: flex; gap: 4px; align-items: center; }
                .url { font-size: 10px; font-family: monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #94a3b8; }
                .copy, .btn { background: rgba(124,58,237,0.2); border: 1px solid rgba(124,58,237,0.4); color: #c4b5fd; border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; white-space: nowrap; }
                .copy:hover, .btn:hover { background: rgba(124,58,237,0.35); }
                .copy:active, .btn:active { transform: scale(0.95); }
                .status { margin: 4px 0; padding: 6px 10px; border-radius: 6px; font-size: 12px; }
                .status.ok { background: rgba(74,222,128,0.1); color: #4ade80; }
                .status.warn { background: rgba(251,191,36,0.1); color: #fbbf24; }
                .actions { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
                .section { margin-bottom: 16px; }
                .sectionTitle { font-size: 13px; font-weight: 600; margin-bottom: 6px; opacity: 0.8; }
            </style></head>
            <body>
                <h2>🔗 Remote Access</h2>

                <div class="section">
                    <div class="sectionTitle">Network Status</div>
                    ${vpnStatus}
                    ${upnpBtn}
                    <button class="btn" id="refreshBtn" style="margin-left:4px">Refresh</button>
                <button class="btn" id="bindBtn" style="margin-left:4px">${this.isBindAll() ? "Bind: 0.0.0.0 ✓" : "Bind: 0.0.0.0"}</button>
                </div>

                <div class="section">
                    <div class="sectionTitle">Connection URLs (scan QR to connect)</div>
                    ${urlCards ? `<div class="grid">${urlCards}</div>` : '<p style="opacity:0.6">No addresses discovered. Click Refresh.</p>'}
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    document.getElementById("refreshBtn")?.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
                    document.getElementById("bindBtn")?.addEventListener("click", () => vscode.postMessage({ type: "bind-all" }));
                    document.getElementById("upnpBtn")?.addEventListener("click", () => vscode.postMessage({ type: "upnp" }));
                    document.querySelectorAll(".copy").forEach(btn => {
                        btn.addEventListener("click", () => vscode.postMessage({ type: "copy", url: btn.getAttribute("data-url") }));
                    });
                </script>
            </body></html>`;
    }
}

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
