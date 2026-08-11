/**
 * Sufficit relay client: publishes the local bridge to a public URL via an
 * outbound WebSocket to the Sufficit gateway, so any device (browser/phone)
 * can reach the Symposium agent without Tailscale, port forwarding, or a
 * tunneling app.
 *
 * Architecture:
 *   Browser/Phone ──HTTPS/WSS──► ai.sufficit.com.br/symposium?machineId=<relayId>
 *                                    │ (reverse proxy)
 *                                    ▼ (WebSocket, established by this client)
 *                              This extension ──► 127.0.0.1:47600 (bridge)
 *
 * The connection is OUTBOUND (this client dials the gateway), so no inbound
 * port needs to be opened on the host machine. The gateway authenticates the
 * WS connection with the Sufficit JWT (same OAuth identity the user already
 * logged in with). HTTP requests arriving via the relay are proxied to the
 * local bridge via fetch; browser WebSockets are multiplexed to local `/ahp`.
 *
 * Protocol (JSON over WebSocket text frames):
 *   ext → gw:  { "type": "register", "machineId": "<uuid>" }
 *   gw → ext:  { "type": "registered", "publicUrl": "https://.../<machineId>" }
 *   gw → ext:  { "type": "request", "id": "<uuid>", "method", "path", "headers", "body" }
 *   ext → gw:  { "type": "response", "id", "status", "headers", "body" }
 *   ext → gw:  { "type": "response-chunk", "id", "chunk", "done" }  (SSE streaming)
 *   gw → ext:  { "type": "socket-open", "id", "path", "protocols" }
 *   ext/gw:    { "type": "socket-frame", "id", "data", "binary" }
 *   ext/gw:    { "type": "socket-close", "id", "code", "reason" }
 *   ext/gw:    { "type": "heartbeat" }  (keepalive every 25s)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { RelaySocketTunnel } from "./relaySocketTunnel";

export interface RelayClientOptions {
    /** WebSocket URL of the relay gateway (e.g. wss://ai.sufficit.com.br/symposium?ws=relay). */
    relayUrl: string;
    /** Local bridge port to proxy requests to (e.g. 47600). */
    bridgePort: number;
    /** Returns the Sufficit JWT to authenticate the outbound connection. */
    getToken: () => Promise<string | null>;
    /** Re-authorizes this machine before each connection/reconnection. */
    authorize?: () => Promise<boolean>;
    /** Called when the public URL is assigned (registered) or lost (disconnect). */
    onPublicUrl?: (url: string | undefined) => void;
    /** Optional logger. */
    log?: (msg: string) => void;
}

let knownRelayPublicUrl: string | undefined;

/** Last public relay URL confirmed by the gateway in this extension process. */
export function getKnownRelayPublicUrl(): string | undefined {
    return knownRelayPublicUrl;
}

/**
 * Stable machine identifier persisted to ~/.symposium/relay-machine-id so the
 * public URL is stable across extension reloads. Generated on first use.
 */
export function getMachineId(): string {
    const file = path.join(os.homedir(), ".symposium", "relay-machine-id");
    try {
        const id = fs.readFileSync(file, "utf8").trim();
        if (id) {
            return id;
        }
    } catch {
        /* not yet created */
    }
    const id = randomUUID();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, id, { mode: 0o600 });
    } catch {
        /* best-effort */
    }
    return id;
}

/**
 * Parses a relay protocol message from a raw WebSocket text frame.
 * Returns undefined for malformed/non-JSON frames.
 */
export function parseRelayMessage(raw: string): Record<string, unknown> | undefined {
    try {
        const obj = JSON.parse(raw);
        return typeof obj === "object" &&
            obj !== null &&
            typeof (obj as Record<string, unknown>).type === "string"
            ? (obj as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Builds a register message for the relay handshake.
 */
export function buildRegisterMessage(machineId: string): string {
    return JSON.stringify({ type: "register", machineId });
}

/**
 * Builds a heartbeat message.
 */
export function buildHeartbeatMessage(): string {
    return JSON.stringify({ type: "heartbeat" });
}

export class RelayClient {
    private ws: WebSocket | undefined;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private backoff = 1000; // ms, doubles up to 60_000
    private running = false;
    private publicUrl: string | undefined;
    private readonly machineId: string;
    private readonly socketTunnel: RelaySocketTunnel;

    constructor(private readonly opts: RelayClientOptions) {
        this.machineId = getMachineId();
        this.socketTunnel = new RelaySocketTunnel({
            bridgePort: opts.bridgePort,
            send: (message) => this.send(message),
            log: (message) => this.log(message),
        });
    }

    /** The public URL the gateway assigned, or undefined until registered. */
    getPublicUrl(): string | undefined {
        return this.publicUrl;
    }

    /** Opens the outbound connection and keeps it alive (reconnect on drop). */
    async start(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        this.backoff = 1000;
        await this.connect();
    }

    /** Closes the connection and stops reconnecting. Idempotent. */
    stop(): void {
        this.running = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                /* best-effort */
            }
            this.ws = undefined;
        }
        this.socketTunnel.closeAll();
        this.publicUrl = undefined;
        knownRelayPublicUrl = undefined;
    }

    private log(msg: string): void {
        this.opts.log?.(`[relay] ${msg}`);
    }

    private async connect(): Promise<void> {
        if (!this.running) {
            return;
        }
        let token: string | null;
        try {
            token = await this.opts.getToken();
        } catch (error) {
            this.log(`token lookup failed: ${error}`);
            this.scheduleReconnect();
            return;
        }
        if (!this.running) return;
        if (!token) {
            this.log("no Sufficit token — not logged in; will retry");
            this.scheduleReconnect();
            return;
        }
        if (this.opts.authorize) {
            try {
                if (!(await this.opts.authorize())) {
                    this.log("machine authorization failed; will retry");
                    this.scheduleReconnect();
                    return;
                }
            } catch (error) {
                this.log(`machine authorization failed: ${error}`);
                this.scheduleReconnect();
                return;
            }
        }
        if (!this.running) return;
        const url = `${this.opts.relayUrl}&machineId=${encodeURIComponent(this.machineId)}&token=${encodeURIComponent(token)}`;
        this.log(`connecting to ${this.opts.relayUrl} (machineId=${this.machineId.slice(0, 8)}…)`);
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            this.log(`WebSocket construction failed: ${e}`);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.on("open", () => {
            this.log("connected, registering");
            this.backoff = 1000; // reset on successful connect
            ws.send(buildRegisterMessage(this.machineId));
            this.startHeartbeat();
        });
        ws.on("message", (data, binary) => {
            const raw = binary ? "" : data.toString();
            const msg = parseRelayMessage(raw);
            if (!msg) {
                return;
            }
            this.handleMessage(msg);
        });
        ws.on("close", () => {
            this.log("connection closed");
            this.stopHeartbeat();
            this.publicUrl = undefined;
            knownRelayPublicUrl = undefined;
            this.socketTunnel.closeAll();
            this.opts.onPublicUrl?.(undefined);
            this.scheduleReconnect();
        });
        ws.on("error", () => {
            this.log("connection error");
            // close handler will schedule reconnect
        });
    }

    private startHeartbeat(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
        }
        this.heartbeat = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(buildHeartbeatMessage());
                } catch {
                    /* best-effort */
                }
            }
        }, 25_000);
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }
    }

    private scheduleReconnect(): void {
        if (!this.running) {
            return;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 60_000);
        this.log(`reconnecting in ${Math.round(delay / 1000)}s`);
        this.reconnectTimer = setTimeout(() => {
            void this.connect();
        }, delay);
    }

    private handleMessage(msg: Record<string, unknown>): void {
        if (this.socketTunnel.handleMessage(msg)) return;
        const type = msg.type as string;
        if (type === "registered") {
            this.publicUrl = msg.publicUrl as string | undefined;
            knownRelayPublicUrl = this.publicUrl;
            this.log(`registered — public URL ${this.publicUrl ?? "(none)"}`);
            this.opts.onPublicUrl?.(this.publicUrl);
        } else if (type === "request") {
            void this.handleProxyRequest(msg);
        }
        // heartbeat/other: ignore
    }

    /**
     * Proxies an HTTP request received via the relay to the local bridge and
     * sends the response back through the WS. For SSE responses (text/event-stream),
     * streams chunks as response-chunk messages.
     */
    private async handleProxyRequest(msg: Record<string, unknown>): Promise<void> {
        const id = msg.id as string;
        const method = (msg.method as string) || "GET";
        const reqPath = (msg.path as string) || "/";
        const headers = (msg.headers as Record<string, string>) || {};
        const body = typeof msg.body === "string" ? msg.body : undefined;
        const target = `http://127.0.0.1:${this.opts.bridgePort}${reqPath}`;
        try {
            const res = await fetch(target, {
                method,
                headers,
                ...(body && method !== "GET" && method !== "HEAD" ? { body } : {}),
            });
            const resHeaders: Record<string, string> = {};
            res.headers.forEach((value, key) => {
                resHeaders[key] = value;
            });
            const contentType = res.headers.get("content-type") || "";
            // SSE / streaming: relay chunk-by-chunk, then a done marker.
            if (contentType.includes("text/event-stream") && res.body) {
                this.send({
                    type: "response",
                    id,
                    status: res.status,
                    headers: resHeaders,
                    stream: true,
                });
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    this.send({
                        type: "response-chunk",
                        id,
                        chunk: decoder.decode(value, { stream: true }),
                    });
                }
                this.send({ type: "response-chunk", id, chunk: "", done: true });
                return;
            }
            // Regular response: read fully and send.
            const text = await res.text();
            this.send({
                type: "response",
                id,
                status: res.status,
                headers: resHeaders,
                body: text,
            });
        } catch (e) {
            this.send({
                type: "response",
                id,
                status: 502,
                headers: {},
                body: `relay proxy error: ${e}`,
            });
        }
    }

    private send(msg: Record<string, unknown>): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(msg));
            } catch {
                /* best-effort */
            }
        }
    }
}
