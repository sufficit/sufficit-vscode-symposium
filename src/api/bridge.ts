import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { ResourceKind } from "../config/root";
import { SymposiumApi, SendMode } from "./symposiumApi";

/** VS Code commands the bridge is allowed to run (browser/navigation only). */
const ALLOWED_COMMANDS = new Set<string>([
    "simpleBrowser.show",
    "simpleBrowser.api.open",
    "vscode.open",
    "workbench.action.browser.toggleDeviceEmulation",
]);

/**
 * Opt-in remote control bridge. Re-publishes the SymposiumApi facade over a
 * local HTTP server so commands can be issued and a chat session followed from
 * outside the VS Code window (e.g. another machine via an authenticated tunnel).
 *
 * Transport: plain HTTP for commands, Server-Sent Events for the chat stream
 * (no extra dependency). Bound to localhost by default and gated by a bearer
 * token. Off unless `symposium.bridge.enabled` is set.
 */
export class RemoteBridge {
    private server: http.Server | undefined;

    constructor(
        private readonly api: SymposiumApi,
        private readonly log: (msg: string) => void,
    ) { }

    /** Starts the bridge if enabled in settings. Returns the bound URL or null. */
    start(): string | null {
        const cfg = vscode.workspace.getConfiguration("symposium.bridge");
        if (!cfg.get<boolean>("enabled", false)) {
            return null;
        }
        const port = cfg.get<number>("port", 47600);
        const host = cfg.get<string>("host", "127.0.0.1");
        let token = cfg.get<string>("token", "");
        if (!token) {
            token = randomUUID();
            this.log(`[bridge] no token configured; generated ephemeral token: ${token}`);
        }

        const url = `http://${host}:${port}`;
        this.server = http.createServer((req, res) => void this.handle(req, res, token));
        this.server.on("error", (err) => this.log(`[bridge] server error: ${err}`));
        this.server.listen(port, host, () => this.log(`[bridge] listening on ${url}`));
        // Publish url+token so local skills/scripts can reach the bridge without
        // hardcoding them.
        try {
            const dir = path.join(os.homedir(), ".symposium");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "bridge.json"), JSON.stringify({ url, token }), { mode: 0o600 });
        } catch (err) { this.log(`[bridge] bridge.json write failed: ${err}`); }
        return url;
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
        try { fs.rmSync(path.join(os.homedir(), ".symposium", "bridge.json"), { force: true }); } catch { /* ignore */ }
    }

    private authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
        const header = req.headers.authorization;
        if (header === `Bearer ${token}`) {
            return true;
        }
        // EventSource cannot set headers, so allow the token as a query param
        // for the SSE follow endpoint only.
        return url.searchParams.get("token") === token;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!this.authorized(req, url, token)) {
            return json(res, 401, { error: "unauthorized" });
        }
        const parts = url.pathname.split("/").filter(Boolean);
        const method = req.method ?? "GET";

        try {
            // GET /health
            if (method === "GET" && parts[0] === "health") {
                return json(res, 200, { ok: true, version: this.api.version });
            }
            // POST /vscode/command  {id, args?}  — run a whitelisted VS Code command
            if (method === "POST" && parts[0] === "vscode" && parts[1] === "command") {
                const body = await readBody(req);
                if (!ALLOWED_COMMANDS.has(body.id)) { return json(res, 403, { error: `command not allowed: ${body.id}` }); }
                const result = await vscode.commands.executeCommand(body.id, ...(Array.isArray(body.args) ? body.args : []));
                return json(res, 200, { ok: true, result: result ?? null });
            }
            // POST /vscode/lmtool  {name, input?}  — invoke a VS Code Language Model Tool
            if (method === "POST" && parts[0] === "vscode" && parts[1] === "lmtool") {
                const body = await readBody(req);
                const cts = new vscode.CancellationTokenSource();
                try {
                    const r = await vscode.lm.invokeTool(body.name, { input: body.input ?? {}, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<object>, cts.token);
                    const content = r.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptPart>;
                    const text = content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : JSON.stringify(p))).join("\n");
                    return json(res, 200, { ok: true, result: text });
                } finally { cts.dispose(); }
            }
            // GET /vscode/lmtools  — list available VS Code Language Model Tools
            if (method === "GET" && parts[0] === "vscode" && parts[1] === "lmtools") {
                const tools = (vscode.lm?.tools ?? []).map((t) => ({ name: t.name, description: t.description, tags: t.tags }));
                return json(res, 200, tools);
            }
            // GET /sessions
            if (method === "GET" && parts[0] === "sessions" && parts.length === 1) {
                return json(res, 200, this.api.sessions.list());
            }
            // POST /sessions  {backend, cwd, model?, tools?}
            if (method === "POST" && parts[0] === "sessions" && parts.length === 1) {
                const body = await readBody(req);
                const id = await this.api.sessions.create(body.backend, { cwd: body.cwd, model: body.model, tools: body.tools, agent: body.agent });
                return id ? json(res, 200, { id }) : json(res, 400, { error: "unknown backend" });
            }
            // POST /sessions/:id/send  {text, mode?}
            if (method === "POST" && parts[0] === "sessions" && parts[2] === "send") {
                const body = await readBody(req);
                const ok = this.api.sessions.send(parts[1], body.text, body.mode as SendMode);
                return json(res, ok ? 200 : 404, { ok });
            }
            // POST /sessions/:id/interrupt
            if (method === "POST" && parts[0] === "sessions" && parts[2] === "interrupt") {
                const ok = this.api.sessions.interrupt(parts[1]);
                return json(res, ok ? 200 : 404, { ok });
            }
            // GET /sessions/:id/follow  (SSE)
            if (method === "GET" && parts[0] === "sessions" && parts[2] === "follow") {
                return this.follow(parts[1], res);
            }
            // GET /resources
            if (method === "GET" && parts[0] === "resources" && parts.length === 1) {
                return json(res, 200, this.api.resources.scan());
            }
            // POST /resources  {kind, name, description?}  | /resources/seed
            if (method === "POST" && parts[0] === "resources") {
                if (parts[1] === "seed") {
                    return json(res, 200, { created: this.api.resources.seed() });
                }
                const body = await readBody(req);
                const path = this.api.resources.create(body.kind as ResourceKind, body.name, body.description);
                return json(res, 200, { path });
            }
            // DELETE /resources/:kind/:name
            if (method === "DELETE" && parts[0] === "resources" && parts.length === 3) {
                this.api.resources.remove(parts[1] as ResourceKind, decodeURIComponent(parts[2]));
                return json(res, 200, { ok: true });
            }
            // GET /backends
            if (method === "GET" && parts[0] === "backends" && parts.length === 1) {
                return json(res, 200, await this.api.backends.list());
            }
            // POST /backends/:backend/test
            if (method === "POST" && parts[0] === "backends" && parts[2] === "test") {
                const s = await this.api.backends.test(parts[1]);
                return json(res, s ? 200 : 404, s ?? { error: "unknown backend" });
            }
            // POST /backends/:backend/model  {value}
            if (method === "POST" && parts[0] === "backends" && parts[2] === "model") {
                const body = await readBody(req);
                const ok = await this.api.backends.setModel(parts[1], body.value ?? "");
                return json(res, ok ? 200 : 400, { ok });
            }
            // POST /backends/:backend/executable  {value}
            if (method === "POST" && parts[0] === "backends" && parts[2] === "executable") {
                const body = await readBody(req);
                const ok = await this.api.backends.setExecutable(parts[1], body.value ?? "");
                return json(res, ok ? 200 : 400, { ok });
            }
            // GET /sync
            if (method === "GET" && parts[0] === "sync" && parts.length === 1) {
                return json(res, 200, this.api.sync.status());
            }
            // GET /sync/health
            if (method === "GET" && parts[0] === "sync" && parts[1] === "health") {
                return json(res, 200, { healthy: await this.api.sync.health() });
            }
            // POST /sync/pull | /sync/push
            if (method === "POST" && parts[0] === "sync" && parts[1] === "pull") {
                return json(res, 200, await this.api.sync.pull());
            }
            if (method === "POST" && parts[0] === "sync" && parts[1] === "push") {
                return json(res, 200, await this.api.sync.push());
            }
            // GET /vault/resolve?reference=
            if (method === "GET" && parts[0] === "vault" && parts[1] === "resolve") {
                const value = await this.api.vault.resolve(url.searchParams.get("reference") ?? "");
                return value == null
                    ? json(res, 404, { error: "unknown/expired/offline" })
                    : json(res, 200, { value });
            }
            return json(res, 404, { error: "not found" });
        } catch (err) {
            return json(res, 500, { error: String(err) });
        }
    }

    /** Opens an SSE stream that mirrors a session's chat to the remote viewer. */
    private follow(id: string, res: http.ServerResponse): void {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        });
        res.write(`event: open\ndata: ${JSON.stringify({ id })}\n\n`);
        const unsubscribe = this.api.sessions.follow(id, (message) => {
            res.write(`data: ${JSON.stringify(message)}\n\n`);
        });
        if (!unsubscribe) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: "unknown session" })}\n\n`);
            res.end();
            return;
        }
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
        res.on("close", () => { clearInterval(keepAlive); unsubscribe(); });
    }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => { data += chunk; if (data.length > 1_000_000) { reject(new Error("body too large")); } });
        req.on("end", () => {
            try {
                resolve((data ? JSON.parse(data) : {}) as Record<string, unknown>);
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}
