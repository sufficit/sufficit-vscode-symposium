import * as http from "http";
import * as https from "https";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { lmToolInvocationOptions } from "../adapters/lmToolInvocation";
import { ResourceKind } from "../config/root";
import { SymposiumApi, SendMode } from "./symposiumApi";
import { isBridgeAuthorized } from "./bridgeAuth";
import { BridgePolicy, resolveBridgePolicy, isCwdAllowed, isHostAllowed, isLmToolAllowed } from "./bridgePolicy";
import { decodeBridgePathSegment } from "./bridgeRoutes";
import { removeBridgeAdvertisement, writeBridgeAdvertisement } from "./bridgeAdvertisement";
import { getJoinedHostname } from "../net/tailnet";
import { RelayClient } from "../net/relayClient";
import { HubClient, getHubLoginToken } from "../sync/hubClient";
import { loadBridgeTlsMaterial } from "./bridgeTls";
import { serveBridgeStatic } from "./bridgeStatic";

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
    private server: http.Server | https.Server | undefined;
    private listening: { host: string; port: number } | undefined;
    private connection: { url: string; token: string; https: boolean } | undefined;
    private lastRejection: { at: string; reason: "allowedHosts"; receivedHost: string; allowedHosts: string[] } | undefined;
    private relay: RelayClient | undefined;
    /** Called when the relay URL changes (connect/disconnect) so the QR panel can refresh. */
    private onRelayUrlChange?: (url: string | undefined) => void;

    /** Register a callback fired when the relay public URL is assigned or lost. */
    setRelayUrlCallback(cb: (url: string | undefined) => void): void { this.onRelayUrlChange = cb; }

    /** The public URL assigned by the Sufficit relay, or undefined when not active. */
    getRelayPublicUrl(): string | undefined { return this.relay?.getPublicUrl(); }

    /** The running bridge's URL/token, for surfaces that need to build a share link (e.g. the remote-access panel). Undefined while stopped. */
    getConnection(): { url: string; token: string; https: boolean } | undefined {
        return this.connection;
    }

    constructor(
        private readonly api: SymposiumApi,
        private readonly log: (msg: string) => void,
    ) { }

    /** Starts the bridge if enabled in settings. Returns the bound URL or null. */
    async start(): Promise<string | null> {
        const cfg = vscode.workspace.getConfiguration("symposium.bridge");
        if (!cfg.get<boolean>("enabled", false)) {
            return null;
        }
        const port = cfg.get<number>("port", 47600);
        const host = cfg.get<string>("host", "127.0.0.1");
        // Workspace-persisted bridge token: stable across reloads so the PWA doesn't
        // lose sync when the extension restarts. Falls back to a global setting,
        // then to a workspace-persisted UUID generated on first run.
        let token = cfg.get<string>("token", "");
        if (!token) {
            const wsState = vscode.workspace.getConfiguration("symposium.bridge");
            const wsToken = wsState.get<string>("_workspaceToken", "");
            if (wsToken) {
                token = wsToken;
            } else {
                token = randomUUID();
                // Persist at workspace level so it survives reloads but is unique
                // per workspace (different workspaces = different tokens = isolated).
                void wsState.update("_workspaceToken", token, vscode.ConfigurationTarget.Workspace);
                this.log("[bridge] generated workspace-persisted token (stable across reloads)");
            }
        }
        if ((cfg.get<string[]>("allowedHosts", []) ?? []).length === 0 && !getJoinedHostname()) {
            this.log("[bridge] symposium.bridge.allowedHosts is empty — Host validation (anti DNS-rebinding) is not enforced; set it once you have a stable tunnel hostname.");
        }

        const tls = await loadBridgeTlsMaterial();
        const url = `${tls ? "https" : "http"}://${host}:${port}`;
        const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handle(req, res, token);
        this.server = tls ? https.createServer(tls, requestHandler) : http.createServer(requestHandler);
        if (!tls) {
            this.log("[bridge] no TLS cert available (vault unreachable or not logged in) — serving plain HTTP; a tailnet PWA client needs HTTPS for its service worker.");
        }
        this.server.on("error", (err) => {
            this.log(`[bridge] server error: ${err}`);
            removeBridgeAdvertisement();
        });
        this.server.listen(port, host, () => {
            this.listening = { host, port };
            this.connection = { url, token, https: !!tls };
            this.log(`[bridge] listening on ${url}`);
            // Publish url+token so local skills/scripts can reach the bridge without
            // hardcoding them, but only after we own the advertised listener.
            try {
                writeBridgeAdvertisement(url, token);
            } catch (err) { this.log(`[bridge] bridge.json write failed: ${err}`); }
            // Start the Sufficit relay (outbound WS → public URL) unless disabled.
            // Lets any device scan the QR and reach this bridge without Tailscale.
            void this.startRelay(port);
        });
        return url;
    }

    /**
     * Connects the Sufficit relay (outbound WS to the gateway) so the bridge is
     * reachable via a public URL. Best-effort: failures (not logged in, gateway
     * doesn't support relay yet) degrade silently — the tailnet/local URL still works.
     */
    private async startRelay(port: number): Promise<void> {
        const relayMode = vscode.workspace.getConfiguration("symposium.bridge").get<string>("relay", "auto");
        if (relayMode === "off") { return; }
        const hub = new HubClient();
        if (!hub.configured()) { return; }
        const machineId = await import("../net/relayClient").then((m) => m.getMachineId());
        const reg = await hub.registerRelay(machineId);
        if (!reg?.ok || !reg.relayWsUrl) {
            this.log("[bridge] relay not available (gateway doesn't support it yet or not logged in); using tailnet/local URL only");
            return;
        }
        this.relay = new RelayClient({
            relayUrl: reg.relayWsUrl,
            bridgePort: port,
            getToken: () => getHubLoginToken(),
            onPublicUrl: (url) => this.onRelayUrlChange?.(url),
            log: (msg) => this.log(msg),
        });
        void this.relay.start();
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

    private authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
        return isBridgeAuthorized(req.headers.authorization, url, token, req.headers["x-symposium-token"]);
    }

    private policy(): BridgePolicy {
        const cfg = vscode.workspace.getConfiguration("symposium.bridge");
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        // Auto-permit this machine's own tailnet hostname (net/tailnet.ts) — an identity
        // the extension itself established, not user input — on top of any explicit config.
        const joinedHostname = getJoinedHostname();
        const allowedHosts = cfg.get<string[]>("allowedHosts", []);
        return resolveBridgePolicy({
            allowedRoots: cfg.get<string[]>("allowedRoots", []),
            workspaceRoots,
            sessionPermission: cfg.get<string>("sessionPermission", "acceptEdits"),
            allowedLmTools: cfg.get<string[]>("allowedLmTools", []),
            allowExecutableOverride: cfg.get<boolean>("allowExecutableOverride", false),
            allowVaultResolve: cfg.get<boolean>("allowVaultResolve", false),
            allowedHosts: joinedHostname ? [...allowedHosts, joinedHostname] : allowedHosts,
        });
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
        const url = new URL(req.url ?? "/", "http://localhost");
        const policy = this.policy();
        // Anti DNS-rebinding: reject a mismatched Host before touching the token.
        if (!isHostAllowed(req.headers.host, policy.allowedHosts)) {
            const receivedHost = req.headers.host?.trim() || "<missing>";
            this.lastRejection = {
                at: new Date().toISOString(),
                reason: "allowedHosts",
                receivedHost,
                allowedHosts: [...policy.allowedHosts],
            };
            this.log(`[bridge] request rejected: Host ${JSON.stringify(receivedHost)} is not in symposium.bridge.allowedHosts (${JSON.stringify(policy.allowedHosts)})`);
            return json(res, 403, {
                error: "host not allowed",
                message: "Bridge request rejected: Host is not in symposium.bridge.allowedHosts.",
            });
        }
        const parts = url.pathname.split("/").filter(Boolean);
        const method = req.method ?? "GET";

        if (method === "GET" && parts[0] === "pwa") {
            if (!vscode.workspace.getConfiguration("symposium.bridge").get<boolean>("pwa", false)) {
                return json(res, 404, { error: "not found" });
            }
            return serveBridgeStatic(parts.slice(1).join("/") || "index.html", res);
        }
        if (!this.authorized(req, url, token)) {
            return json(res, 401, { error: "unauthorized" });
        }

        try {
            // GET /health
            if (method === "GET" && parts[0] === "health") {
                return json(res, 200, { ok: true, version: this.api.version });
            }
            // Non-secret state + latest Host rejection for local diagnosis.
            if (method === "GET" && parts[0] === "bridge" && parts[1] === "diagnostics") {
                return json(res, 200, {
                    ok: true, listening: this.listening ?? null,
                    allowedHosts: policy.allowedHosts, allowedRoots: policy.allowedRoots,
                    sessionPermission: policy.sessionPermission,
                    allowedLmTools: policy.allowedLmTools, allowExecutableOverride: policy.allowExecutableOverride,
                    allowVaultResolve: policy.allowVaultResolve,
                    lastRejection: this.lastRejection ?? null,
                });
            }
            // POST /vscode/command  {id, args?}  — run a whitelisted VS Code command
            if (method === "POST" && parts[0] === "vscode" && parts[1] === "command") {
                const body = await readBody(req);
                if (typeof body.id !== "string") { return json(res, 400, { error: "id must be a string" }); }
                if (!ALLOWED_COMMANDS.has(body.id)) { return json(res, 403, { error: `command not allowed: ${body.id}` }); }
                const result = await vscode.commands.executeCommand(body.id, ...(Array.isArray(body.args) ? body.args : []));
                return json(res, 200, { ok: true, result: result ?? null });
            }
            // POST /vscode/lmtool  {name, input?}  — invoke a VS Code Language Model Tool
            if (method === "POST" && parts[0] === "vscode" && parts[1] === "lmtool") {
                const body = await readBody(req);
                if (typeof body.name !== "string") { return json(res, 400, { error: "name must be a string" }); }
                // LM tools can include terminal execution; require an explicit allowlist.
                if (!isLmToolAllowed(body.name, policy.allowedLmTools)) {
                    return json(res, 403, { error: `lm tool not allowed: ${body.name}` });
                }
                const cts = new vscode.CancellationTokenSource();
                try {
                    const input = isRecord(body.input) ? body.input : {};
                    const r = await vscode.lm.invokeTool(body.name, lmToolInvocationOptions(input), cts.token);
                    const content = r.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>;
                    const text = content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : JSON.stringify(p))).join("\n");
                    return json(res, 200, { ok: true, result: text });
                } finally { cts.dispose(); }
            }
            // GET /vscode/lmtools  — list available VS Code Language Model Tools
            if (method === "GET" && parts[0] === "vscode" && parts[1] === "lmtools") {
                const tools = (vscode.lm?.tools ?? []).map((t) => ({ name: t.name, description: t.description, tags: t.tags }));
                return json(res, 200, tools);
            }
            if (method === "GET" && parts[0] === "sessions" && parts.length === 1) {
                return json(res, 200, this.api.sessions.list());
            }
            // PWA bootstrap metadata. Roots are already an explicit remote-spawn
            // allowlist; exposing them lets the browser start a first session
            // without guessing a local filesystem path.
            if (method === "GET" && parts[0] === "bridge" && parts[1] === "config") {
                return json(res, 200, { allowedRoots: policy.allowedRoots });
            }
            // POST /sessions  {backend, cwd, model?, tools?}
            if (method === "POST" && parts[0] === "sessions" && parts.length === 1) {
                const body = await readBody(req);
                if (typeof body.backend !== "string" || typeof body.cwd !== "string") { return json(res, 400, { error: "backend and cwd are required strings" }); }
                // A remote spawn is arbitrary code execution: confine the cwd to the
                // allowed roots and force a non-bypass permission mode.
                if (!isCwdAllowed(body.cwd, policy.allowedRoots)) {
                    return json(res, 403, { error: "cwd not allowed" });
                }
                const options: { cwd: string; model?: string; tools?: string[]; agent?: string; permission?: string } = {
                    cwd: body.cwd,
                    model: typeof body.model === "string" ? body.model : undefined,
                    tools: Array.isArray(body.tools) ? body.tools : undefined,
                    agent: typeof body.agent === "string" ? body.agent : undefined,
                    permission: policy.sessionPermission,
                };
                const id = await this.api.sessions.create(body.backend, options);
                return id ? json(res, 200, { id }) : json(res, 400, { error: "unknown backend" });
            }
            // POST /sessions/:id/send  {text, mode?}
            if (method === "POST" && parts[0] === "sessions" && parts[2] === "send" && parts.length === 3) {
                const sessionId = decodeBridgePathSegment(parts[1]);
                if (!sessionId) { return json(res, 400, { error: "invalid session id" }); }
                const body = await readBody(req);
                if (typeof body.text !== "string") { return json(res, 400, { error: "text must be a string" }); }
                const mode = body.mode == null ? "send" : body.mode;
                if (mode !== "send" && mode !== "queue" && mode !== "steer") {
                    return json(res, 400, { error: "mode must be send, queue, or steer" });
                }
                const ok = this.api.sessions.send(sessionId, body.text, mode as SendMode);
                return ok
                    ? json(res, 200, { ok: true })
                    : json(res, 404, {
                        ok: false,
                        error: "session is not live",
                        message: "Refresh GET /sessions and use a sessionId returned by the Bridge.",
                    });
            }
            if (method === "POST" && parts[0] === "sessions" && parts[2] === "interrupt" && parts.length === 3) {
                const sessionId = decodeBridgePathSegment(parts[1]);
                if (!sessionId) { return json(res, 400, { error: "invalid session id" }); }
                const ok = this.api.sessions.interrupt(sessionId);
                return json(res, ok ? 200 : 404, { ok });
            }
            // GET /sessions/:id/follow  (SSE)
            if (method === "GET" && parts[0] === "sessions" && parts[2] === "follow" && parts.length === 3) {
                const sessionId = decodeBridgePathSegment(parts[1]);
                if (!sessionId) { return json(res, 400, { error: "invalid session id" }); }
                return this.follow(sessionId, res);
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
                if (typeof body.kind !== "string" || typeof body.name !== "string") { return json(res, 400, { error: "kind and name are required strings" }); }
                const description = typeof body.description === "string" ? body.description : undefined;
                const path = this.api.resources.create(body.kind as ResourceKind, body.name, description);
                return json(res, 200, { path });
            }
            // DELETE /resources/:kind/:name
            if (method === "DELETE" && parts[0] === "resources" && parts.length === 3) {
                const name = decodeURIComponent(parts[2]);
                if (!name) { return json(res, 400, { error: "invalid resource name" }); }
                this.api.resources.remove(parts[1] as ResourceKind, name);
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
                const value = typeof body.value === "string" ? body.value : "";
                const ok = await this.api.backends.setModel(parts[1], value);
                return json(res, ok ? 200 : 400, { ok });
            }
            // POST /backends/:backend/executable  {value}
            if (method === "POST" && parts[0] === "backends" && parts[2] === "executable") {
                // Rewriting the spawn binary is a clean RCE primitive; off unless opted in.
                if (!policy.allowExecutableOverride) {
                    return json(res, 403, { error: "executable override disabled over bridge" });
                }
                const body = await readBody(req);
                const value = typeof body.value === "string" ? body.value : "";
                const ok = await this.api.backends.setExecutable(parts[1], value);
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
                // Direct secret read: off unless explicitly opted in.
                if (!policy.allowVaultResolve) {
                    return json(res, 403, { error: "vault resolve disabled over bridge" });
                }
                const value = await this.api.vault.resolve(url.searchParams.get("reference") ?? "");
                return value == null
                    ? json(res, 404, { error: "unknown/expired/offline" })
                    : json(res, 200, { value });
            }
            return json(res, 404, { error: "not found" });
        } catch (err) {
            // Log the detail server-side; a generic 500 avoids leaking absolute
            // paths / usernames from fs/spawn errors to the remote caller.
            this.log(`[bridge] request error: ${String(err)}`);
            return json(res, 500, { error: "internal error" });
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
        let tooLarge = false;
        req.on("data", (chunk) => {
            if (tooLarge) { return; }
            data += chunk;
            if (data.length > 1_000_000) {
                tooLarge = true;
                reject(new Error("body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (tooLarge) { return; }
            try {
                resolve((data ? JSON.parse(data) : {}) as Record<string, unknown>);
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
