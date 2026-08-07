export function isBridgeAuthorized(
    authorizationHeader: string | string[] | undefined,
    url: URL,
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
    // EventSource cannot set headers, so allow query-token auth only for
    // GET /sessions/:id/follow SSE consumers. Every other endpoint, including
    // /vault/resolve, must use Authorization: Bearer / X-Symposium-Token.
    return (
        /^\/sessions\/[^/]+\/follow\/?$/.test(url.pathname) &&
        url.searchParams.get("token") === token
    );
}
