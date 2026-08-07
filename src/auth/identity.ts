import * as vscode from "vscode";
import {
    DEFAULT_IDENTITY_SCOPE,
    normalizeIdentityScope,
} from "./identityScopes";
import { IdentityTokenManager, OAuthTokenResponse } from "./identityTokenManager";
import {
    Discovery,
    IDENTITY_PROFILE_KEY as PROFILE_KEY,
    SufficitProfile,
} from "./identityTypes";
import { createPkceAuthorization } from "./identityOAuth";

export type { SufficitProfile } from "./identityTypes";

/**
 * Sufficit Identity login. On local desktop VS Code, uses Authorization Code +
 * PKCE with a vscode:// callback (no code to copy). Falls back to Device Flow
 * on remote/SSH/WSL/DevContainer or code-server (where the vscode:// handler
 * can't be reached by the browser).
 */

export class SufficitAuth {
    private profileCache: SufficitProfile | undefined;
    private readonly onChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onChangeEmitter.event;
    // Guards the "credentials not in keyring" notice (shown once per fallback login).
    private persistNoticeShown = false;
    private readonly tokens: IdentityTokenManager;

    // PKCE state: one in-flight login at a time.
    private pendingPkce?: {
        verifier: string;
        state: string;
        resolve: (code: string) => void;
        reject: (err: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
    };

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: (msg: string) => void = () => { },
    ) {
        this.tokens = new IdentityTokenManager({
            context,
            log,
            discovery: () => this.discovery(),
            clientId: () => this.clientId(),
            scope: () => this.scope(),
            onSessionCleared: () => {
                this.profileCache = undefined;
                this.onChangeEmitter.fire();
            },
        });
    }

    /** On activation: arm the silent-refresh timer if already logged in. */
    async startAutoRefresh(): Promise<void> {
        await this.tokens.startAutoRefresh();
    }

    dispose(): void { this.tokens.dispose(); }

    private cfg() {
        return vscode.workspace.getConfiguration("symposium.identity");
    }
    private issuer(): string {
        const v = this.cfg().get<string>("url", "");
        return (v && v.trim() ? v : "https://identity.sufficit.com.br").replace(/\/+$/, "");
    }
    private clientId(): string {
        // Public OAuth client id (not a secret) — baked in so login works out of
        // the box; override via settings only for a custom identity tenant.
        const v = this.cfg().get<string>("clientId", "");
        return v && v.trim() ? v : "sufficit-vscode-symposium";
    }
    private scope(): string {
        return normalizeIdentityScope(this.cfg().get<string>("scope", DEFAULT_IDENTITY_SCOPE));
    }

    private async discovery(): Promise<Discovery> {
        const url = `${this.issuer()}/.well-known/openid-configuration`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`discovery failed: ${res.status} (${url})`);
        }
        return (await res.json()) as Discovery;
    }

    async isLoggedIn(): Promise<boolean> {
        return this.tokens.isLoggedIn();
    }

    /**
     * Surfaces the device-flow verification URL + user code when the external
     * browser opener is unavailable (code-server, headless hosts). Offers a
     * "Copy URL" action so the user can paste it into their browser manually.
     */
    private async showLoginUrlModal(url: string, userCode: string): Promise<void> {
        // Blocking modal (unmissable, unlike a transient toast) that shows the
        // full verification URL and user code. The URL goes in `detail` so it is
        // visible and selectable; "Copy URL" also puts it on the clipboard.
        const action = await vscode.window.showInformationMessage(
            `Sufficit login — a browser tab should have opened. If not, open this URL to authorize (code ${userCode}):`,
            { modal: true, detail: url },
            "Copy URL",
        );
        if (action === "Copy URL") {
            await vscode.env.clipboard.writeText(url);
            void vscode.window.showInformationMessage("Sufficit: login URL copied to clipboard.");
        }
    }

    /** Interactive login. Uses PKCE on local desktop, Device Flow on remote/web. */
    async login(): Promise<SufficitProfile | undefined> {
        // Local desktop (not remote, not web): prefer PKCE Auth Code with
        // vscode:// callback — seamless, no code to copy.
        if (!vscode.env.remoteName && vscode.env.uiKind !== vscode.UIKind.Web) {
            try {
                return await this.loginWithPkce();
            } catch (err) {
                this.log(`[auth] PKCE login failed, falling back to device flow: ${err}`);
                // Fall through to device flow on any PKCE error.
            }
        }
        return this.loginWithDeviceFlow();
    }

    /**
     * Called by the vscode:// URI handler when the browser redirects back
     * after PKCE auth. Validates state and resolves the pending PKCE promise.
     */
    handleRedirect(query: Record<string, string>): void {
        if (!this.pendingPkce) {
            this.log("[auth] PKCE redirect received but no pending login.");
            return;
        }
        const pkce = this.pendingPkce;
        if (query.state !== pkce.state) {
            this.log("[auth] PKCE redirect state mismatch — ignoring.");
            return;
        }
        if (query.error) {
            pkce.reject(new Error(query.error_description ?? query.error));
            this.clearPendingPkce();
            return;
        }
        if (!query.code) {
            pkce.reject(new Error("PKCE redirect: missing authorization code."));
            this.clearPendingPkce();
            return;
        }
        pkce.resolve(query.code);
        this.clearPendingPkce();
    }

    private clearPendingPkce(): void {
        if (this.pendingPkce) {
            clearTimeout(this.pendingPkce.timeout);
            this.pendingPkce = undefined;
        }
    }

    private rejectPendingPkce(error: Error): void {
        const pending = this.pendingPkce;
        if (!pending) { return; }
        pending.reject(error);
        this.clearPendingPkce();
    }

    /**
     * Authorization Code + PKCE login for local desktop VS Code.
     * Opens the browser to the authorize endpoint; the vscode:// handler
     * receives the callback automatically — no code to copy.
     */
    private async loginWithPkce(): Promise<SufficitProfile | undefined> {
        const clientId = this.clientId();
        if (!clientId) {
            void vscode.window.showErrorMessage("Configure symposium.identity.clientId.");
            return undefined;
        }
        const disco = await this.discovery();
        if (!disco.authorization_endpoint) {
            throw new Error("Identity does not advertise authorization_endpoint.");
        }

        const pkce = createPkceAuthorization(
            disco.authorization_endpoint, clientId, this.scope(), vscode.env.uriScheme,
        );
        const { verifier, state, redirectUri, url: authUrl } = pkce;

        // Set up the callback promise (resolved by handleRedirect via the URI handler).
        const authCodePromise = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.rejectPendingPkce(new Error("PKCE login timed out (5 minutes)."));
            }, 5 * 60 * 1000);

            this.pendingPkce = { verifier, state, resolve, reject, timeout };
        });

        // The callback must be armed before opening the browser, otherwise a
        // fast redirect can arrive before handleRedirect() has state to match.
        try {
            const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
            if (!opened) {
                this.rejectPendingPkce(new Error("Unable to open the Sufficit authorization page."));
            }
        } catch (error) {
            this.rejectPendingPkce(error instanceof Error ? error : new Error(String(error)));
        }
        const authCode = await authCodePromise;
        this.clearPendingPkce();

        // Exchange the code for tokens.
        const tokenRes = await fetch(disco.token_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: authCode,
                redirect_uri: redirectUri,
                client_id: clientId,
                code_verifier: verifier,
            }).toString(),
        });
        const tokenBody = await tokenRes.json() as OAuthTokenResponse & { error?: string; error_description?: string };
        if (!tokenRes.ok) {
            throw new Error(`PKCE token exchange failed: ${tokenBody.error_description ?? tokenBody.error ?? tokenRes.status}`);
        }

        await this.tokens.storeResponse(tokenBody, this.scope());
        this.profileCache = undefined;
        const profile = await this.getProfile(true);
        this.onChangeEmitter.fire();
        return profile;
    }

    /** Device Flow login (remote/SSH/web fallback). */
    private async loginWithDeviceFlow(): Promise<SufficitProfile | undefined> {
        const clientId = this.clientId();
        if (!clientId) {
            void vscode.window.showErrorMessage("Configure symposium.identity.clientId (client OAuth registrado no Sufficit Identity).");
            return undefined;
        }
        const disco = await this.discovery();
        if (!disco.device_authorization_endpoint) {
            throw new Error("Identity does not advertise device_authorization_endpoint.");
        }

        // 1. Request a device + user code.
        const devRes = await fetch(disco.device_authorization_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, scope: this.scope() }).toString(),
        });
        const dev = await devRes.json() as { verification_uri_complete?: string; verification_uri?: string; user_code: string; error?: string; device_code?: string; interval?: number; expires_in?: number };
        if (!devRes.ok) {
            throw new Error(`device authorization failed: ${dev.error ?? devRes.status}`);
        }

        const verifyUrl: string = dev.verification_uri_complete ?? dev.verification_uri ?? "";
        if (vscode.env.uiKind === vscode.UIKind.Web) {
            // code-server / web: open the browser directly (the verification URL
            // embeds the user code) and only fall back to the blocking URL modal if
            // openExternal fails — so login doesn't nag once the tab is opening.
            let opened = false;
            try { opened = await vscode.env.openExternal(vscode.Uri.parse(verifyUrl)); } catch { opened = false; }
            if (!opened) { await this.showLoginUrlModal(verifyUrl, dev.user_code); }
        } else {
            const pick = await vscode.window.showInformationMessage(
                `Sufficit: open the browser and confirm the code ${dev.user_code}`, "Open browser", "Copy URL");
            if (pick === "Open browser") {
                try {
                    const opened = await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));
                    if (!opened) { await this.showLoginUrlModal(verifyUrl, dev.user_code); }
                } catch {
                    await this.showLoginUrlModal(verifyUrl, dev.user_code);
                }
            } else if (pick === "Copy URL") {
                await this.showLoginUrlModal(verifyUrl, dev.user_code);
            }
        }

        // 2. Poll the token endpoint until the user approves (or timeout).
        if (!dev.device_code) { return undefined; }
        const tokenResponse = await this.pollToken(disco.token_endpoint, clientId, dev.device_code, dev.interval ?? 5, dev.expires_in ?? 300);
        if (!tokenResponse) {
            return undefined;
        }
        await this.tokens.storeResponse(tokenResponse, this.scope());
        this.profileCache = undefined;
        const profile = await this.getProfile(true);
        this.onChangeEmitter.fire();
        // No system keyring (code-server, container, snap): reassure once that the
        // login is saved to the globalState fallback and survives restarts.
        if (!await this.tokens.isSecretStorageWorking() && !this.persistNoticeShown) {
            this.persistNoticeShown = true;
            void vscode.window.showInformationMessage(
                "Sufficit: login salvo. Este ambiente não tem chaveiro do sistema, então suas credenciais ficam no armazenamento local da extensão (mantidas entre reinícios, menos isoladas que um chaveiro).",
            );
        }
        return profile;
    }

    private async pollToken(tokenEndpoint: string, clientId: string, deviceCode: string, intervalSec: number, expiresInSec: number): Promise<OAuthTokenResponse | undefined> {
        const deadline = Date.now() + expiresInSec * 1000;
        let interval = intervalSec;
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Sufficit: waiting for approval in the browser…", cancellable: true },
            async (_p, token) => {
                while (Date.now() < deadline && !token.isCancellationRequested) {
                    await new Promise((r) => setTimeout(r, interval * 1000));
                    const res = await fetch(tokenEndpoint, {
                        method: "POST",
                        headers: { "content-type": "application/x-www-form-urlencoded" },
                        body: new URLSearchParams({
                            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                            device_code: deviceCode,
                            client_id: clientId,
                        }).toString(),
                    });
                    const j = await res.json() as { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
                    if (res.ok) {
                        return j;
                    }
                    if (j.error === "authorization_pending") { continue; }
                    if (j.error === "slow_down") { interval += 5; continue; }
                    this.log(`[auth] device token error: ${j.error}`);
                    throw new Error(j.error_description ?? j.error ?? "device login failed");
                }
                return undefined;
            });
    }

    /** Whether SecretStorage persists across restarts (false on snap/code-server);
     *  drives the config warning banner. */
    async isSecretStorageWorking(): Promise<boolean> {
        return this.tokens.isSecretStorageWorking();
    }

    /**
     * Valid access token, auto-refreshing when expired. Returns null when not
     * logged in or when the refresh fails — in which case the dead session is
     * cleared and the user is notified once, so callers never send a dead token.
     */
    async getAccessToken(forceRefresh = false): Promise<string | null> {
        return this.tokens.getAccessToken(forceRefresh);
    }

    async getProfile(force = false): Promise<SufficitProfile | undefined> {
        if (this.profileCache && !force) { return this.profileCache; }
        // Instant restore after a window reload: a persisted profile lets the UI
        // show the logged-in account immediately. But only when the access token
        // is still usable — getAccessToken() refreshes on demand, and clears the
        // session (profile included) when the token has expired for good, so we
        // never restore a profile for a session that can no longer authenticate.
        if (!force) {
            const saved = this.context.globalState.get<SufficitProfile>(PROFILE_KEY);
            const token = await this.getAccessToken();
            if (saved && token) {
                this.profileCache = saved;
                void this.getProfile(true).then((p) => { if (p) { this.onChangeEmitter.fire(); } });
                return saved;
            }
            // We have a persisted profile but the token didn't resolve right now
            // (a refresh is in flight, or a transient failure cleared the session
            // without onDidChange reaching a re-push). Don't give up silently: if
            // the session is still alive, a deferred force-fetch will recover the
            // profile and notify the UI. If getProfile(true) also fails, fire the
            // event so the UI reflects the actual logged-out state rather than a
            // stale logged-in footer (or vice-versa).
            if (saved) {
                void this.getProfile(true).then(() => { this.onChangeEmitter.fire(); });
            }
            return undefined;
        }
        const token = await this.getAccessToken();
        if (!token) { return undefined; }
        try {
            const disco = await this.discovery();
            const res = await fetch(disco.userinfo_endpoint ?? `${this.issuer()}/connect/userinfo`, { headers: { authorization: `Bearer ${token}` } });
            if (!res.ok) { return this.profileCache; }   // keep what we have on a transient failure
            const j = await res.json() as { sub?: string; name?: string; preferred_username?: string; email?: string; picture?: string };
            // Avatar comes from the Sufficit contact endpoint keyed by the user id.
            const picture = j.sub
                ? `https://endpoints.sufficit.com.br/contact/avatar?contextid=${encodeURIComponent(j.sub)}`
                : j.picture;
            this.profileCache = { sub: j.sub ?? "", name: j.name ?? j.preferred_username, email: j.email, picture };
            await this.context.globalState.update(PROFILE_KEY, this.profileCache);
            return this.profileCache;
        } catch {
            return this.profileCache;
        }
    }

    async logout(): Promise<void> {
        await this.tokens.logout();
    }
}
