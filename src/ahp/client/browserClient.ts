import {
    SUPPORTED_PROTOCOL_VERSIONS,
    type ActionEnvelope,
    type SessionSummary,
    type StateAction,
    type URI,
} from "@microsoft/agent-host-protocol";
import {
    AhpClient,
    AhpStateMirror,
    type Subscription,
} from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { SymposiumAhpState } from "./state";

export type AhpConnectionStatus = "connecting" | "reconnecting" | "caught-up" | "failed";

export interface BrowserAhpClientOptions {
    url: string;
    token: string;
    clientId: string;
    onState: () => void;
    onAction?: (envelope: ActionEnvelope) => void;
    onStatus: (status: AhpConnectionStatus, detail?: string) => void;
}

export class BrowserAhpClient {
    readonly state = new SymposiumAhpState();
    readonly officialMirror = new AhpStateMirror();
    private client: AhpClient | undefined;
    private readonly subscriptions = new Set<URI>(["ahp-root://" as URI]);
    private closed = false;
    private reconnecting = false;

    constructor(private readonly options: BrowserAhpClientOptions) {}

    async start(): Promise<void> {
        this.options.onStatus("connecting");
        await this.open(false);
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.client?.shutdown();
        this.client = undefined;
    }

    async sessions(): Promise<SessionSummary[]> {
        const result = await this.requireClient().request("listSessions", {
            channel: "ahp-root://",
            limit: 100,
        });
        return result.items;
    }

    async openSession(resource: URI): Promise<void> {
        await this.subscribe(resource);
        const session = this.state.sessions.get(resource);
        if (!session) throw new Error("session snapshot unavailable");
        if (!session.defaultChat) throw new Error("session has no default chat");
        await this.subscribe(session.defaultChat);
    }

    send(chat: URI, text: string, mode: "queue" | "steering" = "queue"): string {
        const id = crypto.randomUUID();
        this.requireClient().dispatch(chat, {
            type: "chat/pendingMessageSet",
            kind: mode,
            id,
            message: { text, origin: { kind: "user" } },
        } as StateAction);
        return id;
    }

    cancel(chat: URI): void {
        const turnId = this.state.chats.get(chat)?.activeTurn?.id;
        if (!turnId) return;
        this.requireClient().dispatch(chat, {
            type: "chat/turnCancelled",
            turnId,
            duration: 0,
        } as StateAction);
    }

    removeQueued(chat: URI, id: string): void {
        this.requireClient().dispatch(chat, {
            type: "chat/pendingMessageRemoved",
            kind: "queued",
            id,
        } as StateAction);
    }

    approve(chat: URI, turnId: string, toolCallId: string, approved: boolean): void {
        this.requireClient().dispatch(chat, {
            type: "chat/toolCallConfirmed",
            turnId,
            toolCallId,
            approved,
            ...(approved ? { confirmed: "user" } : { reason: "denied" }),
        } as StateAction);
    }

    async createSession(provider: string, workingDirectory: string): Promise<URI> {
        const resource = `ahp-session:/${crypto.randomUUID()}` as URI;
        await this.requireClient().request("createSession", {
            channel: resource,
            provider,
            workingDirectory: pathUri(workingDirectory),
        });
        return resource;
    }

    private async open(reconnect: boolean): Promise<void> {
        const transport = await WebSocketTransport.connect(this.options.url, {
            protocols: ["ahp.v0.6", tokenProtocol(this.options.token)],
        });
        const client = new AhpClient(transport);
        this.client = client;
        client.connect();
        if (reconnect) {
            for (const resource of this.subscriptions) client.attachSubscription(resource);
            const result = await client.reconnect({
                clientId: this.options.clientId,
                lastSeenServerSeq: this.state.lastServerSeq,
                subscriptions: [...this.subscriptions],
            });
            if (result.type === "replay") {
                for (const envelope of result.actions) this.apply(envelope);
                for (const missing of result.missing) this.dropSubscription(missing);
            } else {
                for (const snapshot of result.snapshots) this.applySnapshot(snapshot);
            }
        } else {
            const result = await client.initialize({
                clientId: this.options.clientId,
                protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
                initialSubscriptions: ["ahp-root://" as URI],
                locale: navigator.language,
            });
            for (const snapshot of result.snapshots) this.applySnapshot(snapshot);
            client.attachSubscription("ahp-root://" as URI);
        }
        for (const resource of this.subscriptions) {
            this.consume(client.attachSubscription(resource));
        }
        this.options.onState();
        this.options.onStatus("caught-up");
        this.watchConnection(client);
    }

    private async subscribe(resource: URI): Promise<void> {
        if (this.subscriptions.has(resource)) return;
        const { result, subscription } = await this.requireClient().subscribe(resource);
        if (result.snapshot) this.applySnapshot(result.snapshot);
        this.subscriptions.add(resource);
        this.consume(subscription);
        this.options.onState();
    }

    private consume(subscription: Subscription): void {
        void (async () => {
            try {
                for await (const event of subscription) {
                    if (event.type === "action") this.apply(event.params);
                }
            } catch {
                // Connection supervision owns recovery.
            }
        })();
    }

    private apply(envelope: ActionEnvelope): void {
        this.officialMirror.apply(envelope);
        if (this.state.apply(envelope)) this.options.onAction?.(envelope);
    }

    private applySnapshot(snapshot: Parameters<SymposiumAhpState["applySnapshot"]>[0]): void {
        this.officialMirror.applySnapshot(snapshot);
        this.state.applySnapshot(snapshot);
    }

    private watchConnection(client: AhpClient): void {
        void (async () => {
            for await (const state of client.stateChanges()) {
                if (state.status === "closed" && !this.closed && this.client === client) {
                    void this.reconnect();
                    return;
                }
            }
        })();
    }

    private async reconnect(): Promise<void> {
        if (this.reconnecting || this.closed) return;
        this.reconnecting = true;
        this.options.onStatus("reconnecting");
        let delay = 250;
        while (!this.closed) {
            try {
                await this.open(true);
                this.reconnecting = false;
                return;
            } catch (error) {
                this.options.onStatus(
                    "reconnecting",
                    error instanceof Error ? error.message : String(error),
                );
                await wait(delay);
                delay = Math.min(delay * 2, 10_000);
            }
        }
        this.reconnecting = false;
        this.options.onStatus("failed");
    }

    private dropSubscription(resource: URI): void {
        this.subscriptions.delete(resource);
        this.state.remove(resource);
    }

    private requireClient(): AhpClient {
        if (!this.client) throw new Error("AHP client is not connected");
        return this.client;
    }
}

export function tokenProtocol(token: string): string {
    const bytes = new TextEncoder().encode(token);
    let raw = "";
    for (const byte of bytes) raw += String.fromCharCode(byte);
    return `symposium-token.${btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function pathUri(value: string): URI {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value as URI;
    return new URL(`file://${value.startsWith("/") ? "" : "/"}${value}`).toString() as URI;
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
