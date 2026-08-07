import * as vscode from "vscode";

/**
 * Resolves the Sufficit AI **VS Code Ollama gateway** for third-party tools
 * (GitLens, Copilot). Those tools speak the Ollama protocol, so Sufficit exposes
 * an Ollama-compatible endpoint at `<origin>/vscode/{token}` where {token} is a
 * per-user integration token issued by `POST /api/ai/vscode/tokens` (login-authed).
 *
 * The token is cached in globalState and reused; if the cached token no longer
 * authenticates (revoked/expired), a new one is minted. Model suggestions come
 * from the gateway's own `/api/tags`, so the names match exactly what the tool
 * must send back as the model id.
 */
const TOKEN_KEY = "sufficit.vscodeGatewayToken";

export interface GatewayPreset {
    id: string;
    name: string;
}
export interface GatewayResult {
    gatewayUrl: string;
    presets: GatewayPreset[];
}

export async function resolveVSCodeGateway(
    context: vscode.ExtensionContext,
    origin: string,
    loginToken: string,
): Promise<GatewayResult | undefined> {
    if (!origin || !loginToken) {
        return undefined;
    }

    let token = context.globalState.get<string>(TOKEN_KEY) ?? "";
    let presets = token ? await fetchTags(`${origin}/vscode/${token}`) : undefined;

    // Cached token missing/rejected → mint a fresh one and retry.
    if (presets === undefined) {
        const fresh = await createToken(origin, loginToken);
        if (!fresh) {
            return undefined;
        }
        token = fresh;
        await context.globalState.update(TOKEN_KEY, token);
        presets = await fetchTags(`${origin}/vscode/${token}`);
    }

    const gatewayUrl = `${origin}/vscode/${token}`;
    return { gatewayUrl, presets: presets ?? [] };
}

async function createToken(origin: string, loginToken: string): Promise<string> {
    try {
        const res = await fetch(`${origin}/api/ai/vscode/tokens`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${loginToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({ description: "Symposium VS Code integration" }),
        });
        if (!res.ok) {
            return "";
        }
        const d = (await res.json()) as { token?: string };
        return typeof d.token === "string" ? d.token : "";
    } catch {
        return "";
    }
}

/** GET <gateway>/api/tags → preset list, or undefined when the token is rejected. */
async function fetchTags(gatewayUrl: string): Promise<GatewayPreset[] | undefined> {
    try {
        const res = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/api/tags`, {
            headers: { Accept: "application/json" },
        });
        if (!res.ok) {
            return undefined;
        }
        const d = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
        const models = Array.isArray(d.models) ? d.models : [];
        return models
            .map((m) => ({ id: m.model || m.name || "", name: m.name || m.model || "" }))
            .filter((m) => m.id);
    } catch {
        return undefined;
    }
}
