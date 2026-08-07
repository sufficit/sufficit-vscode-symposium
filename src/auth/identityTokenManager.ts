import * as vscode from "vscode";
import { SharedIdentityTokenStore, sharedIdentityTokenStore } from "./tokenStore";
import {
    parseStoredTokens,
    sameStoredTokenVersion,
    SharedIdentitySession,
} from "./sharedIdentitySession";
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
    onSessionChanged: () => void;
}

/** Owns token persistence, scope migration, proactive refresh and logout. */
export class IdentityTokenManager {
    private secretStoragePersists: boolean | undefined;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private refreshInFlight?: Promise<StoredTokens | undefined>;
    private expiredNoticeShown = false;
    private scopeUpgradeNoticeShown = false;
    private readonly useSharedTokenStore: boolean;
    private readonly sharedStore: SharedIdentityTokenStore;
    private readonly sharedSession?: SharedIdentitySession;

    constructor(private readonly options: IdentityTokenManagerOptions) {
        this.useSharedTokenStore = vscode.env.uiKind === vscode.UIKind.Web;
        this.sharedStore = sharedIdentityTokenStore(options.context);
        if (this.useSharedTokenStore) {
            this.sharedSession = new SharedIdentitySession(options.context, this.sharedStore, options.log);
        }
    }

    async startAutoRefresh(): Promise<void> {
        const tokens = await this.readTokens();
        if (tokens && this.hasCurrentScopes(tokens)) {
            this.scheduleRefresh(tokens.expiresAtMs);
        }
        if (this.useSharedTokenStore) {
            this.startSharedStoreWatcher();
        }
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.sharedSession?.dispose();
    }

    async isLoggedIn(): Promise<boolean> {
        const tokens = await this.readTokens();
        return tokens !== undefined && this.hasCurrentScopes(tokens);
    }

    async storeResponse(
        response: OAuthTokenResponse,
        fallbackScope = this.options.scope(),
        sharedLockHeld = false,
    ): Promise<StoredTokens> {
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
        await this.writeTokens(tokens, sharedLockHeld);
        return tokens;
    }

    async isSecretStorageWorking(): Promise<boolean> {
        if (this.useSharedTokenStore) {
            this.secretStoragePersists = false;
            return false;
        }
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
            await this.clearScopeUpgradeSession(tokens);
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
        // Another code-server window may have completed a rotating refresh
        // while this request was waiting. Never erase that newer shared token.
        const latest = await this.readTokens();
        if (latest && this.hasCurrentScopes(latest) && Date.now() < latest.expiresAtMs) {
            return latest.accessToken;
        }
        await this.clearExpiredSession(tokens);
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
            () => { void this.getAccessToken(true); },
            Math.max(10_000, expiresAtMs - Date.now() - 300_000),
        );
    }

    private hasCurrentScopes(tokens: StoredTokens): boolean {
        return hasRequestedIdentityScopes(tokens.scope, this.options.scope());
    }

    private async readTokens(): Promise<StoredTokens | undefined> {
        if (this.useSharedTokenStore) {
            return this.sharedSession!.read();
        }
        const raw = await this.options.context.secrets.get(SECRET_KEY);
        if (raw) {
            const parsed = parseStoredTokens(raw);
            if (parsed) { return parsed; }
        }
        const fallback = this.sharedStore.read()
            ?? this.options.context.globalState.get<string>(FALLBACK_KEY);
        if (fallback) {
            return parseStoredTokens(fallback);
        }
        return undefined;
    }

    private async writeTokens(tokens: StoredTokens, sharedLockHeld = false): Promise<void> {
        const payload = JSON.stringify(tokens);
        if (this.useSharedTokenStore) {
            await this.sharedSession!.write(payload, sharedLockHeld);
            this.secretStoragePersists = false;
            this.scopeUpgradeNoticeShown = false;
            this.scheduleRefresh(tokens.expiresAtMs);
            return;
        }
        await this.options.context.secrets.store(SECRET_KEY, payload);
        this.scopeUpgradeNoticeShown = false;

        if (this.secretStoragePersists === undefined) {
            const readBack = await this.options.context.secrets.get(SECRET_KEY);
            this.secretStoragePersists = readBack === payload
                && vscode.env.uiKind !== vscode.UIKind.Web;
        }
        if (this.secretStoragePersists) {
            try { this.sharedStore.removeToken(); } catch { /* best-effort legacy cleanup */ }
            await this.options.context.globalState.update(FALLBACK_KEY, undefined);
        } else {
            try { this.sharedStore.write(payload); } catch { /* best-effort desktop fallback */ }
            await this.options.context.globalState.update(FALLBACK_KEY, payload);
        }
        this.scheduleRefresh(tokens.expiresAtMs);
    }

    private async refreshOnce(forceRefresh: boolean): Promise<StoredTokens | undefined> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
        this.refreshInFlight = (async () => {
            const observed = await this.readTokens();
            if (this.useSharedTokenStore) {
                try {
                    return await this.sharedSession!.withLock(async () => {
                        const current = this.sharedSession!.readCurrent();
                        // A second browser refreshed or logged out while this one
                        // waited. Reuse that result instead of rotating again.
                        if (!sameStoredTokenVersion(observed, current)) {
                            return current;
                        }
                        return this.refreshCurrent(current, forceRefresh);
                    });
                } catch (error) {
                    this.options.log(`[auth] shared refresh coordination failed: ${error}`);
                    return undefined;
                }
            }
            return this.refreshCurrent(observed, forceRefresh);
        })();
        try {
            return await this.refreshInFlight;
        } finally {
            this.refreshInFlight = undefined;
        }
    }

    private async refreshCurrent(current: StoredTokens | undefined, forceRefresh: boolean): Promise<StoredTokens | undefined> {
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
                    this.useSharedTokenStore,
                );
                this.expiredNoticeShown = false;
                return refreshed;
            }
            this.options.log(`[auth] refresh rejected: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
        } catch (error) {
            this.options.log(`[auth] refresh failed: ${error}`);
        }
        return undefined;
    }

    private async clearStoredSession(expected?: StoredTokens): Promise<boolean> {
        if (this.useSharedTokenStore) {
            try {
                const cleared = await this.sharedSession!.clear(expected);
                if (!cleared) { return false; }
            } catch (error) {
                this.options.log(`[auth] shared logout coordination failed: ${error}`);
                return false;
            }
        } else {
            try { this.sharedStore.removeToken(); } catch { /* best-effort legacy cleanup */ }
        }
        await this.options.context.secrets.delete(SECRET_KEY);
        await this.options.context.globalState.update(FALLBACK_KEY, undefined);
        await this.options.context.globalState.update(PROFILE_KEY, undefined);
        this.options.onSessionCleared();
        return true;
    }

    private async clearExpiredSession(expected: StoredTokens): Promise<void> {
        if (!await this.clearStoredSession(expected)) {
            return;
        }
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

    private async clearScopeUpgradeSession(expected: StoredTokens): Promise<void> {
        if (!await this.clearStoredSession(expected)) {
            return;
        }
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

    private startSharedStoreWatcher(): void {
        this.sharedSession!.watch((tokens) => {
            if (tokens && this.hasCurrentScopes(tokens)) {
                this.scheduleRefresh(tokens.expiresAtMs);
            } else if (this.refreshTimer) {
                clearTimeout(this.refreshTimer);
                this.refreshTimer = undefined;
            }
            this.options.onSessionChanged();
        });
    }
}
