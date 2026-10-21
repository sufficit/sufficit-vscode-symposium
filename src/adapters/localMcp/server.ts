/**
 * In-process MCP server (streamable HTTP, JSON responses only) that exposes
 * Symposium-owned tools to CLI backends such as Claude, Codex and Copilot.
 *
 * Design goals: nothing is persisted (no script, no transcript copy), the
 * listener is loopback-only on an ephemeral port, and every request needs a
 * per-process random bearer token. Disposing the server removes every trace.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const LOCAL_MCP_SESSION_HEADER = "X-SYMPOSIUM-SESSION-ID";

export interface LocalMcpCallContext {
    /** Conversation the calling CLI belongs to (from the session header). */
    sessionId?: string;
}

export interface LocalMcpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    run(args: Record<string, unknown>, ctx: LocalMcpCallContext): string | Promise<string>;
}

export interface LocalMcpEndpoint {
    url: string;
    token: string;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1024 * 1024;

type RpcId = string | number | null;
interface RpcReply {
    jsonrpc: "2.0";
    id: RpcId;
    result?: unknown;
    error?: { code: number; message: string };
}

class RpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
    ) {
        super(message);
    }
}

class BodyTooLarge extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function digest(value: string): Buffer {
    return crypto.createHash("sha256").update(value).digest();
}

function send(
    res: http.ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
): void {
    if (body === undefined) {
        res.writeHead(status, headers).end();
        return;
    }
    res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(
        JSON.stringify(body),
    );
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                // Stop buffering; the caller answers 413 and then drops the socket.
                req.pause();
                reject(new BodyTooLarge());
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

export class LocalMcpServer {
    private server: http.Server | undefined;
    private tokenDigest: Buffer | undefined;
    private port = 0;

    constructor(
        private readonly tools: readonly LocalMcpTool[],
        private readonly log: (message: string) => void = () => undefined,
        private readonly version = "0.0.0",
    ) {}

    /** Starts listening on 127.0.0.1:<ephemeral> and returns the connection details. */
    async start(): Promise<LocalMcpEndpoint> {
        if (this.server) {
            throw new Error("local MCP server already started");
        }
        const token = crypto.randomBytes(32).toString("hex");
        const server = http.createServer((req, res) => void this.handle(req, res));
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        server.on("error", (error) => this.log(`[local-mcp] server error: ${error}`));
        this.server = server;
        this.tokenDigest = digest(token);
        this.port = (server.address() as AddressInfo).port;
        return { url: `http://127.0.0.1:${this.port}/mcp`, token };
    }

    /** Stops listening, drops open connections and forgets the token. */
    async dispose(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        this.tokenDigest = undefined;
        if (!server) {
            return;
        }
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    }

    private refusal(req: http.IncomingMessage): number | undefined {
        // DNS-rebinding guard: only the literal loopback authority is served,
        // and browsers (which always send Origin) are never legitimate callers.
        const host = req.headers.host;
        if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
            return 403;
        }
        if (req.headers.origin !== undefined) {
            return 403;
        }
        const header = req.headers.authorization ?? "";
        const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const expected = this.tokenDigest;
        if (!expected || !crypto.timingSafeEqual(digest(supplied), expected)) {
            return 401;
        }
        return undefined;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const refused = this.refusal(req);
            if (refused) {
                send(res, refused, { error: "forbidden" }, { "WWW-Authenticate": "Bearer" });
            } else if (req.method !== "POST") {
                // No server-initiated stream and no session state to terminate.
                send(res, 405, undefined, { Allow: "POST" });
            } else {
                const header = req.headers[LOCAL_MCP_SESSION_HEADER.toLowerCase()];
                const sessionId = (Array.isArray(header) ? header[0] : header)?.trim();
                await this.respond(res, await readBody(req), { sessionId: sessionId || undefined });
            }
        } catch (error) {
            this.log(`[local-mcp] request failed: ${error}`);
            if (!res.headersSent) {
                const tooLarge = error instanceof BodyTooLarge;
                if (tooLarge) {
                    res.once("finish", () => req.destroy());
                }
                send(res, tooLarge ? 413 : 500, undefined, { Connection: "close" });
            }
        }
    }

    private async respond(
        res: http.ServerResponse,
        raw: string,
        ctx: LocalMcpCallContext,
    ): Promise<void> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            send(res, 400, this.failure(null, new RpcError(-32700, "Parse error")));
            return;
        }
        const batch = Array.isArray(parsed);
        const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        const replies: RpcReply[] = [];
        for (const message of messages) {
            const reply = await this.dispatch(message, ctx);
            if (reply) {
                replies.push(reply);
            }
        }
        if (replies.length === 0) {
            send(res, 202);
            return;
        }
        send(res, 200, batch ? replies : replies[0]);
    }

    private failure(id: RpcId, error: unknown): RpcReply {
        const rpc =
            error instanceof RpcError
                ? error
                : new RpcError(-32603, error instanceof Error ? error.message : String(error));
        return { jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message } };
    }

    private async dispatch(
        message: unknown,
        ctx: LocalMcpCallContext,
    ): Promise<RpcReply | undefined> {
        if (!isRecord(message)) {
            return this.failure(null, new RpcError(-32600, "Invalid Request"));
        }
        // Notifications (no id) and client responses (no method) need no reply.
        if (typeof message.method !== "string" || message.id === undefined) {
            return undefined;
        }
        const id = message.id as RpcId;
        try {
            const params = isRecord(message.params) ? message.params : {};
            return { jsonrpc: "2.0", id, result: await this.call(message.method, params, ctx) };
        } catch (error) {
            return this.failure(id, error);
        }
    }

    private async call(
        method: string,
        params: Record<string, unknown>,
        ctx: LocalMcpCallContext,
    ): Promise<unknown> {
        switch (method) {
            case "initialize":
                return this.initialize(params);
            case "ping":
                return {};
            case "tools/list":
                return { tools: this.tools.map((tool) => this.describe(tool)) };
            case "tools/call":
                return this.callTool(params, ctx);
            default:
                throw new RpcError(-32601, `Method not found: ${method}`);
        }
    }

    private initialize(params: Record<string, unknown>): unknown {
        const requested = String(params.protocolVersion ?? "");
        return {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "symposium", version: this.version },
        };
    }

    private describe(tool: LocalMcpTool): unknown {
        return {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
        };
    }

    private async callTool(
        params: Record<string, unknown>,
        ctx: LocalMcpCallContext,
    ): Promise<unknown> {
        const tool = this.tools.find((candidate) => candidate.name === params.name);
        if (!tool) {
            throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
        }
        const args = isRecord(params.arguments) ? params.arguments : {};
        try {
            return { content: [{ type: "text", text: await tool.run(args, ctx) }] };
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text }], isError: true };
        }
    }
}
