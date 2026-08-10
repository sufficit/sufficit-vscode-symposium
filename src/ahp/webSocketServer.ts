import * as http from "http";
import type { Duplex } from "stream";
import type { ActionEnvelope, URI } from "@microsoft/agent-host-protocol";
import { WebSocket, WebSocketServer } from "ws";
import { isHostAllowed, type BridgePolicy } from "../api/bridgePolicy";
import type { SymposiumApi } from "../api/symposiumApi";
import { AHP_ROOT_URI } from "./channelUris";
import type { AhpHostRuntime } from "./hostRuntime";
import { isAhpUpgradeAuthorized, rejectAhpUpgrade } from "./webSocketAuth";
export { ahpTokenProtocol } from "./webSocketAuth";
import {
    createSession,
    dispatchClientAction,
    disposeSession,
    listSessions,
    resolveLimits,
    type AhpRequestOutcome,
    type AhpWebSocketLimits,
} from "./webSocketRequests";
export type { AhpWebSocketLimits } from "./webSocketRequests";
import {
    AHP_RPC_ERRORS,
    AHP_SUPPORTED_PROTOCOL_VERSIONS,
    parseAhpWireMessage,
    rpcError,
    rpcNotification,
    rpcResult,
    stringArray,
    type AhpWireMessage,
} from "./wireProtocol";

export interface AhpWebSocketServerOptions {
    server: http.Server;
    token: string;
    runtime: AhpHostRuntime;
    api: SymposiumApi;
    policy: BridgePolicy;
    log: (message: string) => void;
    syncRuntime?: () => void;
    limits?: AhpWebSocketLimits;
}

interface ClientState {
    socket: WebSocket;
    initialized: boolean;
    clientId?: string;
    subscriptions: Map<URI, () => void>;
    malformed: number;
    requests: number[];
}

export class AhpWebSocketServer {
    private readonly webSockets: WebSocketServer;
    private readonly clients = new Set<ClientState>();
    private readonly connectionAttempts = new Map<string, number[]>();
    private readonly limits: Required<AhpWebSocketLimits>;
    private readonly upgradeListener: (
        request: http.IncomingMessage,
        socket: Duplex,
        head: Buffer,
    ) => void;

    constructor(private readonly options: AhpWebSocketServerOptions) {
        this.limits = resolveLimits(options.limits);
        this.webSockets = new WebSocketServer({
            noServer: true,
            maxPayload: this.limits.maxFrameBytes,
            perMessageDeflate: false,
            handleProtocols: (protocols) => (protocols.has("ahp.v0.6") ? "ahp.v0.6" : false),
        });
        this.upgradeListener = (request, socket, head) => this.upgrade(request, socket, head);
        options.server.on("upgrade", this.upgradeListener);
    }

    close(): void {
        this.options.server.off("upgrade", this.upgradeListener);
        for (const client of this.clients) client.socket.close(1001, "server shutdown");
        this.clients.clear();
        this.webSockets.close();
    }

    private upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/ahp") return;
        const remote = request.socket.remoteAddress ?? "unknown";
        if (!this.acceptConnectionRate(remote))
            return rejectAhpUpgrade(socket, 429, "rate limited");
        if (this.clients.size >= this.limits.maxConnections) {
            return rejectAhpUpgrade(socket, 503, "connection limit reached");
        }
        if (!isHostAllowed(request.headers.host, this.options.policy.allowedHosts)) {
            this.options.log(`[ahp] upgrade rejected: host policy (${remote})`);
            return rejectAhpUpgrade(socket, 403, "host not allowed");
        }
        if (!isAhpUpgradeAuthorized(request, url, this.options.token)) {
            this.options.log(`[ahp] upgrade rejected: unauthorized (${remote})`);
            return rejectAhpUpgrade(socket, 401, "unauthorized");
        }
        this.webSockets.handleUpgrade(request, socket, head, (webSocket) =>
            this.onConnection(webSocket),
        );
    }

    private onConnection(socket: WebSocket): void {
        const client: ClientState = {
            socket,
            initialized: false,
            subscriptions: new Map(),
            malformed: 0,
            requests: [],
        };
        this.clients.add(client);
        socket.on("message", (data, binary) => {
            if (binary) return this.rejectFrame(client, undefined, "binary frames are unsupported");
            void this.receive(client, data.toString()).catch((error) => {
                this.options.log(
                    `[ahp] request failed (${client.clientId ?? "uninitialized"}): ${String(error)}`,
                );
                this.send(client, rpcError(0, AHP_RPC_ERRORS.internal, "internal error"));
            });
        });
        socket.on("close", () => this.removeClient(client));
        socket.on("error", () => this.removeClient(client));
    }

    private async receive(client: ClientState, payload: string): Promise<void> {
        if (!this.acceptRequestRate(client)) {
            client.socket.close(1008, "request rate exceeded");
            return;
        }
        const parsed = parseAhpWireMessage(payload, this.limits.maxFrameBytes);
        if (!parsed.ok) return this.rejectFrame(client, parsed.id, parsed.message, parsed.code);
        const message = parsed.message;
        if (message.method === "ping") return this.respond(client, message, null);
        if (
            !client.initialized &&
            message.method !== "initialize" &&
            message.method !== "reconnect"
        ) {
            return this.respondError(
                client,
                message,
                AHP_RPC_ERRORS.invalidRequest,
                "initialize or reconnect first",
            );
        }
        switch (message.method) {
            case "initialize":
                return this.initialize(client, message);
            case "reconnect":
                return this.reconnect(client, message);
            case "subscribe":
                return this.subscribe(client, message);
            case "unsubscribe":
                return this.unsubscribe(client, message.params.channel);
            case "listSessions":
                return this.respondOutcome(
                    client,
                    message,
                    listSessions(this.options.runtime, message),
                );
            case "createSession":
                return this.respondOutcome(
                    client,
                    message,
                    await createSession(this.options, message),
                );
            case "disposeSession":
                return this.respondOutcome(client, message, disposeSession(this.options, message));
            case "dispatchAction":
                return dispatchClientAction(
                    this.options,
                    client.clientId ?? "unknown",
                    message.params,
                );
        }
    }

    private initialize(client: ClientState, message: AhpWireMessage): void {
        if (client.initialized)
            return this.respondError(
                client,
                message,
                AHP_RPC_ERRORS.invalidRequest,
                "already initialized",
            );
        const versions = stringArray(message.params.protocolVersions);
        const version = AHP_SUPPORTED_PROTOCOL_VERSIONS.find((item) => versions.includes(item));
        const clientId = message.params.clientId;
        if (
            message.params.channel !== AHP_ROOT_URI ||
            typeof clientId !== "string" ||
            !clientId ||
            !version
        ) {
            const code = version ? AHP_RPC_ERRORS.invalidParams : AHP_RPC_ERRORS.unsupportedVersion;
            return this.respondError(
                client,
                message,
                code,
                version ? "invalid initialize params" : "unsupported protocol version",
                {
                    protocolVersions: AHP_SUPPORTED_PROTOCOL_VERSIONS,
                },
            );
        }
        const initial = stringArray(message.params.initialSubscriptions) as URI[];
        if (initial.length > this.limits.maxSubscriptions) {
            return this.respondError(
                client,
                message,
                AHP_RPC_ERRORS.invalidParams,
                "subscription limit exceeded",
            );
        }
        const { snapshots, missing } = this.options.runtime.snapshots(initial);
        if (missing.length)
            return this.respondError(
                client,
                message,
                AHP_RPC_ERRORS.invalidParams,
                "unknown subscription",
                { missing },
            );
        client.initialized = true;
        client.clientId = clientId;
        for (const resource of initial) this.installSubscription(client, resource);
        this.respond(client, message, {
            protocolVersion: version,
            serverSeq: this.options.runtime.store.serverSeq,
            serverInfo: {
                name: "symposium-vscode",
                version: this.options.api.version,
                title: "Symposium",
            },
            snapshots,
        });
    }

    private reconnect(client: ClientState, message: AhpWireMessage): void {
        const clientId = message.params.clientId;
        const lastSeen = message.params.lastSeenServerSeq;
        const resources = stringArray(message.params.subscriptions) as URI[];
        if (
            typeof clientId !== "string" ||
            !Number.isSafeInteger(lastSeen) ||
            (lastSeen as number) < 0
        ) {
            return this.respondError(
                client,
                message,
                AHP_RPC_ERRORS.invalidParams,
                "invalid reconnect params",
            );
        }
        if (resources.length > this.limits.maxSubscriptions) {
            return this.respondError(
                client,
                message,
                AHP_RPC_ERRORS.invalidParams,
                "subscription limit exceeded",
            );
        }
        const result = this.options.runtime.reconnect(lastSeen as number, resources);
        client.initialized = true;
        client.clientId = clientId;
        for (const resource of resources) {
            if (this.options.runtime.store.has(resource))
                this.installSubscription(client, resource);
        }
        this.respond(client, message, result);
    }

    private subscribe(client: ClientState, message: AhpWireMessage): void {
        const resource = message.params.channel;
        if (typeof resource !== "string" || !this.options.runtime.store.has(resource as URI)) {
            return this.respondError(
                client,
                message,
                AHP_RPC_ERRORS.invalidParams,
                "unknown channel",
            );
        }
        if (
            !client.subscriptions.has(resource as URI) &&
            client.subscriptions.size >= this.limits.maxSubscriptions
        ) {
            return this.respondError(
                client,
                message,
                AHP_RPC_ERRORS.invalidParams,
                "subscription limit exceeded",
            );
        }
        this.installSubscription(client, resource as URI);
        this.respond(client, message, { snapshot: this.options.runtime.snapshot(resource as URI) });
    }

    private unsubscribe(client: ClientState, resource: unknown): void {
        if (typeof resource !== "string") return;
        client.subscriptions.get(resource as URI)?.();
        client.subscriptions.delete(resource as URI);
    }

    private installSubscription(client: ClientState, resource: URI): void {
        if (client.subscriptions.has(resource)) return;
        client.subscriptions.set(
            resource,
            this.options.runtime.subscribe(resource, (envelope: ActionEnvelope) =>
                this.send(client, rpcNotification("action", envelope)),
            ),
        );
    }

    private respond(client: ClientState, message: AhpWireMessage, result: unknown): void {
        this.send(client, rpcResult(message.id as number, result));
    }

    private respondOutcome(
        client: ClientState,
        message: AhpWireMessage,
        outcome: AhpRequestOutcome,
    ): void {
        if (outcome.ok) this.respond(client, message, outcome.result);
        else this.respondError(client, message, outcome.code, outcome.message, outcome.data);
    }

    private respondError(
        client: ClientState,
        message: AhpWireMessage,
        code: number,
        text: string,
        data?: unknown,
    ): void {
        this.send(client, rpcError(message.id, code, text, data));
    }

    private rejectFrame(
        client: ClientState,
        id: number | undefined,
        text: string,
        code: number = AHP_RPC_ERRORS.invalidRequest,
    ): void {
        client.malformed++;
        this.send(client, rpcError(id, code, text));
        if (client.malformed >= this.limits.maxMalformedFrames)
            client.socket.close(1008, "too many malformed frames");
    }

    private send(client: ClientState, payload: string): void {
        if (client.socket.readyState !== WebSocket.OPEN) return;
        if (
            client.socket.bufferedAmount + Buffer.byteLength(payload) >
            this.limits.maxQueuedBytes
        ) {
            client.socket.close(1013, "slow consumer");
            return;
        }
        client.socket.send(payload);
    }

    private removeClient(client: ClientState): void {
        if (!this.clients.delete(client)) return;
        for (const unsubscribe of client.subscriptions.values()) unsubscribe();
        client.subscriptions.clear();
    }

    private acceptRequestRate(client: ClientState): boolean {
        const now = Date.now();
        client.requests = client.requests.filter((time) => now - time < 1_000);
        client.requests.push(now);
        return client.requests.length <= this.limits.maxRequestsPerSecond;
    }

    private acceptConnectionRate(remote: string): boolean {
        const now = Date.now();
        const attempts = (this.connectionAttempts.get(remote) ?? []).filter(
            (time) => now - time < 60_000,
        );
        attempts.push(now);
        this.connectionAttempts.set(remote, attempts);
        return attempts.length <= this.limits.maxConnectionsPerMinute;
    }
}
