import * as vscode from "vscode";
import { readFallbackToken, writeFallbackToken } from "./tokenStore";
import {
    IDENTITY_FALLBACK_KEY as FALLBACK_KEY,
    IDENTITY_PROFILE_KEY as PROFILE_KEY,
    IDENTITY_SECRET_KEY as SECRET_KEY,
    Discovery,
    StoredTokens,
} from "./identityTypes";
import { hasRequestedIdentityScopes } from "./identityScopes";
import { parseOAuthJson } from "./oauthHttp";

export interface OAuthTokenResponse {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    id_token?: string;
}

interface IdentityTokenManagerOptions {
    context: vscode.ExtensionContext;
    log: (message: string) => void;
    discovery: () => Promise<Discovery>;
    clientId: () => string;
    scope: () => string;
    onSessionCleared: () => void;
}

/** Owns token persistence, scope migration, proactive refresh and logout. */
export class IdentityTokenManager {
    private secretStoragePersists: boolean | undefined;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private refreshInFlight?: Promise<StoredTokens | undefined>;
    private expiredNoticeShown = false;
    private scopeUpgradeNoticeShown = false;

    constructor(private readonly options: IdentityTokenManagerOptions) { }

    async startAutoRefresh(): Promise<void> {
        const tokens = await this.readTokens();
        if (tokens && this.hasCurrentScopes(tokens)) {
            this.scheduleRefresh(tokens.expiresAtMs);
        }
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
    }

    async isLoggedIn(): Promise<boolean> {
        const tokens = await this.readTokens();
        return tokens !== undefined && this.hasCurrentScopes(tokens);
    }

    async storeResponse(response: OAuthTokenResponse, fallbackScope = this.options.scope()): Promise<StoredTokens> {
        const tokens: StoredTokens = {
            accessToken: response.access_token ?? "",
            refreshToken: response.refresh_token,
            idToken: response.id_token,
            // Some compliant token endpoints omit scope when it is unchanged.
            // Persist the requested/granted value so future scope upgrades can
            // invalidate only legacy sessions instead of causing opaque 403s.
            scope: response.scope?.trim() || fallbackScope,
            expiresAtMs: Date.now() + ((response.expires_in ?? 3600) * 1000),
        };
        await this.writeTokens(tokens);
        return tokens;
    }

    async isSecretStorageWorking(): Promise<boolean> {
        if (this.secretStoragePersists === undefined) {
            // Throwaway marker under a dedicated key (never SECRET_KEY). Web hosts
            // are non-persistent (in-memory SecretStorage; same-session readback lies).
            const probeKey = SECRET_KEY + ".probe";
            const marker = "symposium-probe";
            await this.options.context.secrets.store(probeKey, marker);
            this.secretStoragePersists = (await this.options.context.secrets.get(probeKey)) === marker
                && vscode.env.uiKind !== vscode.UIKind.Web;
            await this.options.context.secrets.delete(probeKey);
        }
        return this.secretStoragePersists;
    }

    async getAccessToken(forceRefresh = false): Promise<string | null> {
        const tokens = await this.readTokens();
        if (!tokens) {
            return null;
        }
        if (!this.hasCurrentScopes(tokens)) {
            await this.clearScopeUpgradeSession();
            return null;
        }
        if (!forceRefresh && Date.now() < tokens.expiresAtMs - 60_000) {
            this.expiredNoticeShown = false;
            return tokens.accessToken;
        }

        const refreshed = await this.refreshOnce(forceRefresh);
        if (refreshed) {
            return refreshed.accessToken;
        }
        await this.clearExpiredSession();
        return null;
    }

    async logout(): Promise<void> {
        await this.clearStoredSession();
    }

    private scheduleRefresh(expiresAtMs: number): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(
            () => { void this.getAccessToken(); },
            Math.max(10_000, expiresAtMs - Date.now() - 300_000),
        );
    }

    private hasCurrentScopes(tokens: StoredTokens): boolean {
        return hasRequestedIdentityScopes(tokens.scope, this.options.scope());
    }

    private async readTokens(): Promise<StoredTokens | undefined> {
        const raw = await this.options.context.secrets.get(SECRET_KEY);
        if (raw) {
            try { return JSON.parse(raw) as StoredTokens; } catch { /* malformed */ }
        }
        const fallback = readFallbackToken(this.options.context)
            ?? this.options.context.globalState.get<string>(FALLBACK_KEY);
        if (fallback) {
            try { return JSON.parse(fallback) as StoredTokens; } catch { /* malformed */ }
        }
        return undefined;
    }

    private async writeTokens(tokens: StoredTokens): Promise<void> {
        const payload = JSON.stringify(tokens);
        await this.options.context.secrets.store(SECRET_KEY, payload);
        this.scopeUpgradeNoticeShown = false;

        if (this.secretStoragePersists === undefined) {
            const readBack = await this.options.context.secrets.get(SECRET_KEY);
            this.secretStoragePersists = readBack === payload
                && vscode.env.uiKind !== vscode.UIKind.Web;
        }
        if (this.secretStoragePersists) {
            writeFallbackToken(this.options.context, undefined);
            await this.options.context.globalState.update(FALLBACK_KEY, undefined);
        } else {
            writeFallbackToken(this.options.context, payload);
            await this.options.context.globalState.update(FALLBACK_KEY, payload);
        }
        this.scheduleRefresh(tokens.expiresAtMs);
    }

    private async refreshOnce(forceRefresh: boolean): Promise<StoredTokens | undefined> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
        this.refreshInFlight = (async () => {
            const current = await this.readTokens();
            if (!forceRefresh && current && Date.now() < current.expiresAtMs - 60_000) {
                return current;
            }
            if (!current?.refreshToken) {
                return undefined;
            }
            try {
                const discovery = await this.options.discovery();
                const response = await fetch(discovery.token_endpoint, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        grant_type: "refresh_token",
                        refresh_token: current.refreshToken,
                        client_id: this.options.clientId(),
                    }).toString(),
                });
                if (response.ok) {
                    const refreshed = await this.storeResponse(
                        await parseOAuthJson<OAuthTokenResponse>(response, "Sufficit refresh token endpoint"),
                        current.scope ?? this.options.scope(),
                    );
                    this.expiredNoticeShown = false;
                    return refreshed;
                }
                this.options.log(`[auth] refresh rejected: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
            } catch (error) {
                this.options.log(`[auth] refresh failed: ${error}`);
            }
            return undefined;
        })();
        try {
            return await this.refreshInFlight;
        } finally {
            this.refreshInFlight = undefined;
        }
    }

    private async clearStoredSession(): Promise<void> {
        await this.options.context.secrets.delete(SECRET_KEY);
        writeFallbackToken(this.options.context, undefined);
        await this.options.context.globalState.update(FALLBACK_KEY, undefined);
        await this.options.context.globalState.update(PROFILE_KEY, undefined);
        this.options.onSessionCleared();
    }

    private async clearExpiredSession(): Promise<void> {
        await this.clearStoredSession();
        if (this.expiredNoticeShown) {
            return;
        }
        this.expiredNoticeShown = true;
        void vscode.window.showWarningMessage(
            "Your Sufficit session expired and could not be refreshed automatically.",
            "Sign in again",
        ).then((choice) => {
            if (choice === "Sign in again") {
                void vscode.commands.executeCommand("symposium.login");
            }
        });
    }

    private async clearScopeUpgradeSession(): Promise<void> {
        await this.clearStoredSession();
        if (this.scopeUpgradeNoticeShown) {
            return;
        }
        this.scopeUpgradeNoticeShown = true;
        void vscode.window.showWarningMessage(
            "Sufficit permissions were updated. Sign in again to authorize AI access.",
            "Sign in",
        ).then((choice) => {
            if (choice === "Sign in") {
                void vscode.commands.executeCommand("symposium.login");
            }
        });
    }
}
