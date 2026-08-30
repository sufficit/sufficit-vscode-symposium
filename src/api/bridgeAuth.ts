export function isBridgeAuthorized(
    authorizationHeader: string | string[] | undefined,
    _url: URL,
    token: string,
    customTokenHeader?: string | string[] | undefined,
): boolean {
    if (authorizationHeader === `Bearer ${token}`) {
        return true;
    }
    // Dedicated header, so the bridge token doesn't collide with an
    // `Authorization: Basic` gate added by a fronting reverse proxy (e.g. Plesk
    // Basic Auth in front of a public subdomain). The browser can only send one
    // `Authorization`; the PWA sends its bridge token here instead.
    if (typeof customTokenHeader === "string" && customTokenHeader === token) {
        return true;
    }
    // Query-string credentials are intentionally rejected. Browser clients use
    // the authenticated AHP WebSocket and HTTP callers must use a header.
    return false;
}
