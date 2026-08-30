import type * as http from "http";

export type BridgeRoute = { method: string; parts: string[]; url: URL };

/** VS Code commands the bridge is allowed to run (browser/navigation only). */
export const ALLOWED_BRIDGE_COMMANDS = new Set([
    "simpleBrowser.show",
    "simpleBrowser.api.open",
    "vscode.open",
    "workbench.action.browser.toggleDeviceEmulation",
]);

/** Decodes one URL path segment without letting malformed escapes crash routing. */
export function decodeBridgePathSegment(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    try {
        return decodeURIComponent(value);
    } catch {
        return undefined;
    }
}

export function writeBridgeJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(payload);
}

export function readBridgeBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let data = "";
        let tooLarge = false;
        req.on("data", (chunk) => {
            if (tooLarge) {
                return;
            }
            data += chunk;
            if (data.length > 1_000_000) {
                tooLarge = true;
                reject(new Error("body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (tooLarge) {
                return;
            }
            try {
                resolve((data ? JSON.parse(data) : {}) as Record<string, unknown>);
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

export function isBridgeRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
