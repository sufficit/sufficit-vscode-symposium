import { Buffer } from "node:buffer";
import { WebSocket, type RawData } from "ws";

const MAX_SOCKET_MESSAGE_BYTES = 1_048_576;
const MAX_PROTOCOLS = 16;

export interface RelaySocketTunnelOptions {
    bridgePort: number;
    send: (message: Record<string, unknown>) => void;
    log?: (message: string) => void;
}

interface LocalSocket {
    id: string;
    socket: WebSocket;
    opened: boolean;
    finished: boolean;
}

/** Multiplexes public browser WebSockets over the relay control connection. */
export class RelaySocketTunnel {
    private readonly sockets = new Map<string, LocalSocket>();

    constructor(private readonly options: RelaySocketTunnelOptions) {}

    handleMessage(message: Record<string, unknown>): boolean {
        switch (message.type) {
            case "socket-open":
                this.open(message);
                return true;
            case "socket-frame":
                this.frame(message);
                return true;
            case "socket-close":
                this.close(message);
                return true;
            default:
                return false;
        }
    }

    closeAll(): void {
        for (const local of this.sockets.values()) {
            local.finished = true;
            try {
                local.socket.close(1012, "relay disconnected");
            } catch {
                local.socket.terminate();
            }
        }
        this.sockets.clear();
    }

    private open(message: Record<string, unknown>): void {
        const id = boundedString(message.id, 128);
        const target = localAhpUrl(message.path, this.options.bridgePort);
        if (!id || !target || this.sockets.has(id)) {
            if (id) this.notifyClose(id, 1008, "invalid socket open");
            return;
        }
        const protocols = relayProtocols(message.protocols);
        let socket: WebSocket;
        try {
            socket = new WebSocket(target, protocols, {
                handshakeTimeout: 10_000,
                maxPayload: MAX_SOCKET_MESSAGE_BYTES,
                perMessageDeflate: false,
            });
        } catch (error) {
            this.notifyClose(id, 1011, errorMessage(error));
            return;
        }
        const local: LocalSocket = { id, socket, opened: false, finished: false };
        this.sockets.set(id, local);
        socket.on("open", () => {
            if (local.finished) return;
            local.opened = true;
            this.options.send({
                type: "socket-opened",
                id,
                protocol: socket.protocol || undefined,
            });
        });
        socket.on("message", (data, binary) => this.fromLocal(local, data, binary));
        socket.on("close", (code, reason) =>
            this.finish(local, code || 1000, reason.toString() || "local socket closed", true),
        );
        socket.on("error", (error) => {
            if (!local.opened) this.finish(local, 1011, errorMessage(error), true);
        });
    }

    private frame(message: Record<string, unknown>): void {
        const id = boundedString(message.id, 128);
        const local = id ? this.sockets.get(id) : undefined;
        if (!local || local.finished || local.socket.readyState !== WebSocket.OPEN) return;
        const encoded = typeof message.data === "string" ? message.data : "";
        const data = decodeBase64(encoded);
        if (!data || data.byteLength > MAX_SOCKET_MESSAGE_BYTES) {
            this.finish(local, 1009, "relay frame exceeds limit", true);
            return;
        }
        try {
            local.socket.send(data, { binary: message.binary === true });
        } catch (error) {
            this.finish(local, 1011, errorMessage(error), true);
        }
    }

    private close(message: Record<string, unknown>): void {
        const id = boundedString(message.id, 128);
        const local = id ? this.sockets.get(id) : undefined;
        if (!local) return;
        this.finish(
            local,
            validCloseCode(message.code) ? message.code : 1000,
            boundedString(message.reason, 100) || "remote socket closed",
            false,
        );
    }

    private fromLocal(local: LocalSocket, raw: RawData, binary: boolean): void {
        if (local.finished) return;
        const data = rawDataBuffer(raw);
        if (data.byteLength > MAX_SOCKET_MESSAGE_BYTES) {
            this.finish(local, 1009, "local frame exceeds limit", true);
            return;
        }
        this.options.send({
            type: "socket-frame",
            id: local.id,
            data: data.toString("base64"),
            binary,
        });
    }

    private finish(local: LocalSocket, code: number, reason: string, notify: boolean): void {
        if (local.finished) return;
        local.finished = true;
        this.sockets.delete(local.id);
        if (notify) this.notifyClose(local.id, code, reason);
        try {
            local.socket.close(code, closeReason(reason));
        } catch {
            local.socket.terminate();
        }
        this.options.log?.(`socket ${local.id.slice(0, 8)} closed (${code})`);
    }

    private notifyClose(id: string, code: number, reason: string): void {
        this.options.send({ type: "socket-close", id, code, reason: closeReason(reason) });
    }
}

export function localAhpUrl(value: unknown, bridgePort: number): string | undefined {
    if (typeof value !== "string" || !value.startsWith("/")) return undefined;
    const url = new URL(value, `ws://127.0.0.1:${bridgePort}`);
    if (url.hostname !== "127.0.0.1" || url.port !== String(bridgePort)) return undefined;
    if (url.pathname !== "/ahp") return undefined;
    return url.toString();
}

export function relayProtocols(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter(
            (item): item is string =>
                typeof item === "string" &&
                item.length > 0 &&
                item.length <= 256 &&
                /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(item),
        )
        .slice(0, MAX_PROTOCOLS);
}

function rawDataBuffer(value: RawData): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return Buffer.concat(value);
    return Buffer.from(value);
}

function decodeBase64(value: string): Buffer | undefined {
    if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
    return Buffer.from(value, "base64");
}

function boundedString(value: unknown, maximum: number): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= maximum
        ? value
        : undefined;
}

function validCloseCode(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1000 &&
        value <= 4999 &&
        value !== 1005 &&
        value !== 1006 &&
        value !== 1015
    );
}

function closeReason(value: string): string {
    return Buffer.from(value)
        .subarray(0, 100)
        .toString()
        .replace(/\uFFFD$/u, "");
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
