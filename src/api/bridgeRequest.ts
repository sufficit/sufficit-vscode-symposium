import * as http from "http";
import * as vscode from "vscode";
import { lmToolInvocationOptions } from "../adapters/lmToolInvocation";
import type { SymposiumApi } from "./symposiumApi";
import { configuredBridgePolicy, isConfiguredBridgeAuthorized } from "./bridgeConfiguration";
import { isHostAllowed, isLmToolAllowed } from "./bridgePolicy";
import {
    ALLOWED_BRIDGE_COMMANDS,
    type BridgeRoute,
    isBridgeRecord,
    readBridgeBody,
    writeBridgeJson,
} from "./bridgeRoutes";
import { serveBridgeStatic } from "./bridgeStatic";
import { handleBridgeResourceRoutes } from "./bridgeResourceRoutes";

type Rejection = {
    at: string;
    reason: "allowedHosts";
    receivedHost: string;
    allowedHosts: string[];
};

export interface BridgeRequestDeps {
    api: SymposiumApi;
    log: (message: string) => void;
    discovery?: {
        manifest: () => unknown;
        openapi: () => unknown;
    };
    listening?: { host: string; port: number };
    lastRejection?: Rejection;
    setLastRejection: (rejection: Rejection) => void;
}

type Policy = ReturnType<typeof configuredBridgePolicy>;
type Route = BridgeRoute;

export async function handleBridgeRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    token: string,
    deps: BridgeRequestDeps,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const policy = configuredBridgePolicy();
    if (!authorizeHost(request, response, policy, deps)) return;
    const route = {
        method: request.method ?? "GET",
        parts: url.pathname.split("/").filter(Boolean),
        url,
    };
    if (route.method === "GET" && route.parts[0] === "pwa") {
        if (!vscode.workspace.getConfiguration("symposium.bridge").get<boolean>("pwa", false)) {
            return writeBridgeJson(response, 404, { error: "not found" });
        }
        return serveBridgeStatic(route.parts.slice(1).join("/") || "index.html", response);
    }
    if (route.method === "GET" && route.parts.join("/") === ".well-known/symposium.json") {
        if (!deps.discovery) return writeBridgeJson(response, 404, { error: "not found" });
        return writeBridgeJson(response, 200, deps.discovery.manifest(), {
            "Cache-Control": "no-cache",
        });
    }
    if (route.method === "GET" && route.parts.length === 1 && route.parts[0] === "openapi.json") {
        if (!deps.discovery) return writeBridgeJson(response, 404, { error: "not found" });
        return writeBridgeJson(response, 200, deps.discovery.openapi(), {
            "Cache-Control": "no-cache",
        });
    }
    if (!isConfiguredBridgeAuthorized(request, url, token)) {
        return writeBridgeJson(response, 401, { error: "unauthorized" });
    }
    try {
        if (handleInfoRoutes(response, route, policy, deps)) return;
        if (await handleVscodeRoutes(request, response, route, policy)) return;
        if (await handleBridgeResourceRoutes(request, response, route, deps.api)) return;
        if (await handleBackendRoutes(request, response, route, policy, deps.api)) return;
        if (await handleSyncVaultRoutes(response, route, policy, deps.api)) return;
        writeBridgeJson(response, 404, { error: "not found" });
    } catch (error) {
        deps.log(`[bridge] request error: ${String(error)}`);
        writeBridgeJson(response, 500, { error: "internal error" });
    }
}

function authorizeHost(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    policy: Policy,
    deps: BridgeRequestDeps,
): boolean {
    if (isHostAllowed(request.headers.host, policy.allowedHosts)) return true;
    const receivedHost = request.headers.host?.trim() || "<missing>";
    const rejection: Rejection = {
        at: new Date().toISOString(),
        reason: "allowedHosts",
        receivedHost,
        allowedHosts: [...policy.allowedHosts],
    };
    deps.setLastRejection(rejection);
    deps.log(
        `[bridge] request rejected: Host ${JSON.stringify(receivedHost)} is not in symposium.bridge.allowedHosts (${JSON.stringify(policy.allowedHosts)})`,
    );
    writeBridgeJson(response, 403, {
        error: "host not allowed",
        message: "Bridge request rejected: Host is not in symposium.bridge.allowedHosts.",
    });
    return false;
}

function handleInfoRoutes(
    response: http.ServerResponse,
    route: Route,
    policy: Policy,
    deps: BridgeRequestDeps,
): boolean {
    const [first, second] = route.parts;
    if (route.method === "GET" && first === "health") {
        writeBridgeJson(response, 200, { ok: true, version: deps.api.version });
        return true;
    }
    if (route.method === "GET" && first === "bridge" && second === "diagnostics") {
        writeBridgeJson(response, 200, {
            ok: true,
            listening: deps.listening ?? null,
            allowedHosts: policy.allowedHosts,
            allowedRoots: policy.allowedRoots,
            sessionPermission: policy.sessionPermission,
            allowedLmTools: policy.allowedLmTools,
            allowExecutableOverride: policy.allowExecutableOverride,
            allowVaultResolve: policy.allowVaultResolve,
            lastRejection: deps.lastRejection ?? null,
        });
        return true;
    }
    if (route.method === "GET" && first === "bridge" && second === "config") {
        writeBridgeJson(response, 200, { allowedRoots: policy.allowedRoots });
        return true;
    }
    return false;
}

async function handleVscodeRoutes(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    route: Route,
    policy: Policy,
): Promise<boolean> {
    const [first, second] = route.parts;
    if (route.method === "POST" && first === "vscode" && second === "command") {
        const body = await readBridgeBody(request);
        if (typeof body.id !== "string") {
            writeBridgeJson(response, 400, { error: "id must be a string" });
        } else if (!ALLOWED_BRIDGE_COMMANDS.has(body.id)) {
            writeBridgeJson(response, 403, { error: `command not allowed: ${body.id}` });
        } else {
            const result = await vscode.commands.executeCommand(
                body.id,
                ...(Array.isArray(body.args) ? body.args : []),
            );
            writeBridgeJson(response, 200, { ok: true, result: result ?? null });
        }
        return true;
    }
    if (route.method === "POST" && first === "vscode" && second === "lmtool") {
        await invokeLmTool(request, response, policy);
        return true;
    }
    if (route.method === "GET" && first === "vscode" && second === "lmtools") {
        writeBridgeJson(
            response,
            200,
            (vscode.lm?.tools ?? []).map((tool) => ({
                name: tool.name,
                description: tool.description,
                tags: tool.tags,
            })),
        );
        return true;
    }
    return false;
}

async function invokeLmTool(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    policy: Policy,
): Promise<void> {
    const body = await readBridgeBody(request);
    if (typeof body.name !== "string") {
        return writeBridgeJson(response, 400, { error: "name must be a string" });
    }
    if (!isLmToolAllowed(body.name, policy.allowedLmTools)) {
        return writeBridgeJson(response, 403, { error: `lm tool not allowed: ${body.name}` });
    }
    const cts = new vscode.CancellationTokenSource();
    try {
        const result = await vscode.lm.invokeTool(
            body.name,
            lmToolInvocationOptions(isBridgeRecord(body.input) ? body.input : {}),
            cts.token,
        );
        const content = result.content as Array<
            vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart
        >;
        const text = content
            .map((part) =>
                part instanceof vscode.LanguageModelTextPart ? part.value : JSON.stringify(part),
            )
            .join("\n");
        writeBridgeJson(response, 200, { ok: true, result: text });
    } finally {
        cts.dispose();
    }
}

async function handleBackendRoutes(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    route: Route,
    policy: Policy,
    api: SymposiumApi,
): Promise<boolean> {
    const [first, backend, action] = route.parts;
    if (first !== "backends") return false;
    if (route.method === "GET" && route.parts.length === 1) {
        writeBridgeJson(response, 200, await api.backends.list());
        return true;
    }
    if (route.method !== "POST") return false;
    if (action === "test") {
        const status = await api.backends.test(backend);
        writeBridgeJson(response, status ? 200 : 404, status ?? { error: "unknown backend" });
        return true;
    }
    if (action === "model") {
        const body = await readBridgeBody(request);
        const ok = await api.backends.setModel(
            backend,
            typeof body.value === "string" ? body.value : "",
        );
        writeBridgeJson(response, ok ? 200 : 400, { ok });
        return true;
    }
    if (action === "executable") {
        if (!policy.allowExecutableOverride) {
            writeBridgeJson(response, 403, { error: "executable override disabled over bridge" });
            return true;
        }
        const body = await readBridgeBody(request);
        const ok = await api.backends.setExecutable(
            backend,
            typeof body.value === "string" ? body.value : "",
        );
        writeBridgeJson(response, ok ? 200 : 400, { ok });
        return true;
    }
    return false;
}

async function handleSyncVaultRoutes(
    response: http.ServerResponse,
    route: Route,
    policy: Policy,
    api: SymposiumApi,
): Promise<boolean> {
    const [first, action] = route.parts;
    if (first === "sync" && route.method === "GET" && route.parts.length === 1) {
        writeBridgeJson(response, 200, api.sync.status());
        return true;
    }
    if (first === "sync" && route.method === "GET" && action === "health") {
        writeBridgeJson(response, 200, { healthy: await api.sync.health() });
        return true;
    }
    if (first === "sync" && route.method === "POST" && action === "pull") {
        writeBridgeJson(response, 200, await api.sync.pull());
        return true;
    }
    if (first === "sync" && route.method === "POST" && action === "push") {
        writeBridgeJson(response, 200, await api.sync.push());
        return true;
    }
    if (first === "vault" && route.method === "GET" && action === "resolve") {
        if (!policy.allowVaultResolve) {
            writeBridgeJson(response, 403, { error: "vault resolve disabled over bridge" });
            return true;
        }
        const value = await api.vault.resolve(route.url.searchParams.get("reference") ?? "");
        writeBridgeJson(
            response,
            value == null ? 404 : 200,
            value == null ? { error: "unknown/expired/offline" } : { value },
        );
        return true;
    }
    return false;
}
