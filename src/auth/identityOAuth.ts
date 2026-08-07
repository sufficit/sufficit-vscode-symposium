import * as crypto from "node:crypto";

/** Stable extension authority registered as the Sufficit Identity redirect URI. */
export const SUFFICIT_VSCODE_EXTENSION_ID = "sufficit.sufficit-vscode-symposium";

export interface PkceAuthorizationRequest {
    endpoint: string;
    clientId: string;
    redirectUri: string;
    scope: string;
    challenge: string;
    state: string;
}

export interface PkceAuthorization {
    verifier: string;
    state: string;
    redirectUri: string;
    url: URL;
}

/**
 * Builds the callback handled by vscode.window.registerUriHandler(). The editor
 * scheme changes for Insiders builds, but the URI authority is always the
 * extension id; prefixing the authority with the scheme produces an
 * unregistered redirect URI.
 */
export function identityRedirectUri(uriScheme?: string): string {
    const scheme = uriScheme?.trim() || "vscode";
    return `${scheme}://${SUFFICIT_VSCODE_EXTENSION_ID}/callback`;
}

/** Pure RFC 7636 authorization URL builder, shared by login and unit tests. */
export function buildPkceAuthorizationUrl(request: PkceAuthorizationRequest): URL {
    const url = new URL(request.endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", request.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("scope", request.scope);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", request.challenge);
    url.searchParams.set("state", request.state);
    return url;
}

/** Creates the verifier, challenge, state and URL for one PKCE login attempt. */
export function createPkceAuthorization(
    endpoint: string,
    clientId: string,
    scope: string,
    uriScheme?: string,
): PkceAuthorization {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("base64url");
    const redirectUri = identityRedirectUri(uriScheme);
    const url = buildPkceAuthorizationUrl({
        endpoint, clientId, redirectUri, scope, challenge, state,
    });
    return { verifier, state, redirectUri, url };
}
