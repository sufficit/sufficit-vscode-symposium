import { OpenAIAdapterConfig } from "./types";
import { getOpenAITokenProvider } from "./token";

/**
 * Build the HTTP headers for an OpenAI-compatible request: starts from the
 * configured headers, layers in client identity (x-client-* + user-agent), and
 * resolves authorization — an explicit `authorization` header wins, then the
 * configured apiKey (Bearer), finally the logged-in Sufficit login token.
 *
 * Extracted from OpenAISession.headers() so discovery and the turn runner share
 * one implementation. Pure: reads only cfg + the optional login token.
 */
export function buildHeaders(
    cfg: OpenAIAdapterConfig,
    loginToken?: string | null,
): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", ...cfg.headers };
    if (cfg.clientInfo) {
        h["x-client-id"] = cfg.clientInfo.id;
        h["x-client-version"] = cfg.clientInfo.version;
        h["x-client-hostname"] = cfg.clientInfo.hostname;
        h["x-client-os"] = cfg.clientInfo.os;
        h["user-agent"] = `${cfg.clientInfo.id}/${cfg.clientInfo.version} (${cfg.clientInfo.os}; ${cfg.clientInfo.hostname})`;
    }
    const hasAuth = Object.keys(h).some((k) => k.toLowerCase() === "authorization");
    if (!hasAuth && cfg.apiKey) {
        h["authorization"] = `Bearer ${cfg.apiKey}`;
    } else if (!hasAuth && loginToken) {
        // Fall back to the logged-in Sufficit token (native backend).
        h["authorization"] = `Bearer ${loginToken}`;
    }
    return h;
}

/**
 * Resolve the login token only when needed (no explicit auth configured). When
 * the gateway already has an Authorization header or an apiKey, or no token
 * provider is registered, returns null — meaning no login token is required.
 *
 * Extracted from OpenAISession.authToken().
 */
export async function resolveAuthToken(cfg: OpenAIAdapterConfig): Promise<string | null> {
    const provider = getOpenAITokenProvider();
    const hasAuth = Object.keys(cfg.headers).some((k) => k.toLowerCase() === "authorization");
    if (hasAuth || cfg.apiKey || !provider) { return null; }
    try { return await provider(); } catch { return null; }
}
