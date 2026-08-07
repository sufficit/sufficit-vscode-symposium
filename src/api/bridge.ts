import { randomUUID } from "crypto";
import * as http from "http";
import * as https from "https";
import * as vscode from "vscode";
import { RelayClient } from "../net/relayClient";
import { getJoinedHostname } from "../net/tailnet";
import { getHubLoginToken, HubClient } from "../sync/hubClient";
import { removeBridgeAdvertisement, writeBridgeAdvertisement } from "./bridgeAdvertisement";
import { handleBridgeRequest } from "./bridgeRequest";
import { loadBridgeTlsMaterial } from "./bridgeTls";
import type { SymposiumApi } from "./symposiumApi";

type HostRejection = {
    at: string;
    reason: "allowedHosts";
    receivedHost: string;
    allowedHosts: string[];
};

/** Opt-in authenticated HTTP/SSE bridge for remote Symposium control. */
export class RemoteBridge {
    private server: http.Server | https.Server | undefined;
    private listening: { host: string; port: number } | undefined;
    private connection: { url: string; token: string; https: boolean } | undefined;
    private lastRejection: HostRejection | undefined;
    private relay: RelayClient | undefined;
    private onRelayUrlChange?: (url: string | undefined) => void;

    constructor(
        private readonly api: SymposiumApi,
        private readonly log: (message: string) => void,
    ) {}

    setRelayUrlCallback(callback: (url: string | undefined) => void): void {
        this.onRelayUrlChange = callback;
    }

    getRelayPublicUrl(): string | undefined {
        return this.relay?.getPublicUrl();
    }

    getConnection(): { url: string; token: string; https: boolean } | undefined {
        return this.connection;
    }

    async start(): Promise<string | null> {
        const config = vscode.workspace.getConfiguration("symposium.bridge");
        if (!config.get<boolean>("enabled", false)) return null;
        const port = config.get<number>("port", 47600);
        const host = config.get<string>("host", "127.0.0.1");
        const token = await this.resolveToken(config);
        if ((config.get<string[]>("allowedHosts", []) ?? []).length === 0 && !getJoinedHostname()) {
            this.log(
                "[bridge] symposium.bridge.allowedHosts is empty — Host validation is not enforced.",
            );
        }
        const tls = await loadBridgeTlsMaterial();
        const url = `${tls ? "https" : "http"}://${host}:${port}`;
        const handler = (request: http.IncomingMessage, response: http.ServerResponse) =>
            void this.handle(request, response, token);
        this.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
        if (!tls) {
            this.log("[bridge] no TLS cert available — serving plain HTTP.");
        }
        this.server.on("error", (error) => {
            this.log(`[bridge] server error: ${error}`);
            removeBridgeAdvertisement();
        });
        this.server.listen(port, host, () => this.onListening(host, port, url, token, !!tls));
        return url;
    }

    stop(): void {
        this.relay?.stop();
        this.relay = undefined;
        this.server?.close();
        this.server = undefined;
        this.listening = undefined;
        this.connection = undefined;
        removeBridgeAdvertisement();
    }

    private async resolveToken(config: vscode.WorkspaceConfiguration): Promise<string> {
        const configured = config.get<string>("token", "");
        if (configured) return configured;
        const persisted = config.get<string>("_workspaceToken", "");
        if (persisted) return persisted;
        const token = randomUUID();
        await config.update("_workspaceToken", token, vscode.ConfigurationTarget.Workspace);
        this.log("[bridge] generated workspace-persisted token (stable across reloads)");
        return token;
    }

    private onListening(
        host: string,
        port: number,
        url: string,
        token: string,
        tls: boolean,
    ): void {
        this.listening = { host, port };
        this.connection = { url, token, https: tls };
        this.log(`[bridge] listening on ${url}`);
        try {
            writeBridgeAdvertisement(url, token);
        } catch (error) {
            this.log(`[bridge] bridge.json write failed: ${error}`);
        }
        void this.startRelay(port);
    }

    private async startRelay(port: number): Promise<void> {
        const mode = vscode.workspace
            .getConfiguration("symposium.bridge")
            .get<string>("relay", "auto");
        if (mode === "off") return;
        const hub = new HubClient();
        if (!hub.configured()) return;
        const machineId = await import("../net/relayClient").then((module) =>
            module.getMachineId(),
        );
        const registration = await hub.registerRelay(machineId);
        if (!registration?.ok || !registration.relayWsUrl) {
            this.log("[bridge] relay unavailable; using tailnet/local URL only");
            return;
        }
        this.relay = new RelayClient({
            relayUrl: registration.relayWsUrl,
            bridgePort: port,
            getToken: () => getHubLoginToken(),
            onPublicUrl: (url) => this.onRelayUrlChange?.(url),
            log: (message) => this.log(message),
        });
        void this.relay.start();
    }

    private handle(
        request: http.IncomingMessage,
        response: http.ServerResponse,
        token: string,
    ): Promise<void> {
        return handleBridgeRequest(request, response, token, {
            api: this.api,
            log: this.log,
            listening: this.listening,
            lastRejection: this.lastRejection,
            setLastRejection: (rejection) => {
                this.lastRejection = rejection;
            },
            follow: (id, target) => this.follow(id, target),
        });
    }

    private follow(id: string, response: http.ServerResponse): void {
        response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        response.write(`event: open\ndata: ${JSON.stringify({ id })}\n\n`);
        const unsubscribe = this.api.sessions.follow(id, (message) => {
            response.write(`data: ${JSON.stringify(message)}\n\n`);
        });
        if (!unsubscribe) {
            response.write(
                `event: error\ndata: ${JSON.stringify({ error: "unknown session" })}\n\n`,
            );
            response.end();
            return;
        }
        const keepAlive = setInterval(() => response.write(": ping\n\n"), 15000);
        response.on("close", () => {
            clearInterval(keepAlive);
            unsubscribe();
        });
    }
}
