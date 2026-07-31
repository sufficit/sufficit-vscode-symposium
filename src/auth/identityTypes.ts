export interface SufficitProfile {
    sub?: string;
    name?: string;
    email?: string;
    picture?: string;
}

export interface StoredTokens {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAtMs: number;
}

export interface Discovery {
    token_endpoint: string;
    device_authorization_endpoint?: string;
    userinfo_endpoint?: string;
}

export const IDENTITY_SECRET_KEY = "sufficit.identity.tokens";
export const IDENTITY_PROFILE_KEY = "sufficit.identity.profile";
export const IDENTITY_FALLBACK_KEY = "sufficit.identity.tokens.fallback";
