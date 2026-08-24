import type * as http from "http";
import type { Duplex } from "stream";
import { isBridgeAuthorized } from "../api/bridgeAuth";

export function ahpTokenProtocol(token: string): string {
    return `symposium-token.${Buffer.from(token).toString("base64url")}`;
}

export function rejectAhpUpgrade(socket: Duplex, status: number, message: string): void {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function isAhpUpgradeAuthorized(
    request: http.IncomingMessage,
    url: URL,
    token: string,
): boolean {
    if (
        isBridgeAuthorized(
            request.headers.authorization,
            url,
            token,
            request.headers["x-symposium-token"],
        )
    ) {
        return true;
    }
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim());
    return protocols.includes(ahpTokenProtocol(token));
}
