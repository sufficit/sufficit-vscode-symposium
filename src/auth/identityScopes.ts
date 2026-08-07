/** Scopes required by the Sufficit AI authorization contract. */
export const REQUIRED_IDENTITY_AUTHORIZATION_SCOPES = ["roles", "directives"] as const;

/** Default scopes requested by Symposium during PKCE and device-flow login. */
export const DEFAULT_IDENTITY_SCOPE = "openid profile email roles directives offline_access";

/**
 * Keeps custom scope configuration while guaranteeing that the Identity server
 * can emit the role/directive claims required by Sufficit AI policies.
 */
export function normalizeIdentityScope(configured?: string): string {
    const values = (configured?.trim() || DEFAULT_IDENTITY_SCOPE).split(/\s+/).filter(Boolean);
    const unique = new Set(values);
    for (const required of REQUIRED_IDENTITY_AUTHORIZATION_SCOPES) {
        unique.add(required);
    }
    return [...unique].join(" ");
}

/** Returns whether a stored token grant covers every currently requested scope. */
export function hasRequestedIdentityScopes(
    granted: string | undefined,
    requested: string,
): boolean {
    if (!granted?.trim()) {
        return false;
    }

    const grantedScopes = new Set(granted.trim().split(/\s+/).filter(Boolean));
    return requested
        .split(/\s+/)
        .filter(Boolean)
        .every((scope) => grantedScopes.has(scope));
}
