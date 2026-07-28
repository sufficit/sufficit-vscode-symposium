import * as vscode from "vscode";
import { readFallbackToken, writeFallbackToken } from "./tokenStore";

/**
 * Sufficit Identity login via OAuth 2.0 Device Authorization Grant against the
 * Duende IdentityServer at identity.sufficit.com.br (device flow needs no
 * redirect URI — works in desktop VS Code and code-server). Tokens live in
 * SecretStorage (fallback file when no keyring); profile from /connect/userinfo.
 * Public client with device_code grant + openid/profile/email/offline_access.
 */

export interface SufficitProfile {
    sub?: string;
    name?: string;
    email?: string;
    picture?: string;
}

interface StoredTokens {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAtMs: number;
}

interface Discovery {
    token_endpoint: string;
    device_authorization_endpoint?: string;
    userinfo_endpoint?: string;
}

const SECRET_KEY = "sufficit.identity.tokens";
const PROFILE_KEY = "sufficit.identity.profile";
/** Fallback token store key (globalState) when SecretStorage doesn't persist. */
const FALLBACK_KEY = "sufficit.identity.tokens.fallback";

export class SufficitAuth {
    private profileCache: SufficitProfile | undefined;
    private readonly onChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onChangeEmitter.event;
    // Guards the "session expired" notice against spamming.
    private expiredNoticeShown = false;
    // Guards the "credentials not in keyring" notice (shown once per fallback login).
    private persistNoticeShown = false;
    // Whether SecretStorage persists (probed once on first write, then cached).
    private secretStoragePersists: boolean | undefined;

    private refreshTimer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: (msg: string) => void = () => { },
    ) { }

    // Silently refresh ~5 min before expiry so the token never lapses and the
    // refresh token keeps sliding (avoids "expired, could not be renewed").
    private scheduleRefresh(expiresAtMs: number): void {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.refreshTimer = setTimeout(() => { void this.getAccessToken(); }, Math.max(10_000, expiresAtMs - Date.now() - 300_000));
    }

    /** On activation: arm the silent-refresh timer if already logged in. */
    async startAutoRefresh(): Promise<void> {
        const t = await this.readTokens();
        if (t) { this.scheduleRefresh(t.expiresAtMs); }
    }

    dispose(): void { if (this.refreshTimer) { clearTimeout(this.refreshTimer); } }

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
        return this.cfg().get<string>("scope", "openid profile email offline_access");
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
        return (await this.readTokens()) !== undefined;
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

    /** Interactive device-code login. Returns the profile on success. */
    async login(): Promise<SufficitProfile | undefined> {
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
        const tokens = await this.pollToken(disco.token_endpoint, clientId, dev.device_code, dev.interval ?? 5, dev.expires_in ?? 300);
        if (!tokens) {
            return undefined;
        }
        await this.writeTokens(tokens);
        this.profileCache = undefined;
        const profile = await this.getProfile(true);
        this.onChangeEmitter.fire();
        // No system keyring (code-server, container, snap): reassure once that the
        // login is saved to the globalState fallback and survives restarts.
        if (this.secretStoragePersists === false && !this.persistNoticeShown) {
            this.persistNoticeShown = true;
            void vscode.window.showInformationMessage(
                "Sufficit: login salvo. Este ambiente não tem chaveiro do sistema, então suas credenciais ficam no armazenamento local da extensão (mantidas entre reinícios, menos isoladas que um chaveiro).",
            );
        }
        return profile;
    }

    private async pollToken(tokenEndpoint: string, clientId: string, deviceCode: string, intervalSec: number, expiresInSec: number): Promise<StoredTokens | undefined> {
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
                        return this.toStored(j);
                    }
                    if (j.error === "authorization_pending") { continue; }
                    if (j.error === "slow_down") { interval += 5; continue; }
                    this.log(`[auth] device token error: ${j.error}`);
                    throw new Error(j.error_description ?? j.error ?? "device login failed");
                }
                return undefined;
            });
    }

    private toStored(j: { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string }): StoredTokens {
        return {
            accessToken: j.access_token ?? "",
            refreshToken: j.refresh_token,
            idToken: j.id_token,
            expiresAtMs: Date.now() + ((j.expires_in ?? 3600) * 1000),
        };
    }

    private async readTokens(): Promise<StoredTokens | undefined> {
        const raw = await this.context.secrets.get(SECRET_KEY);
        if (raw) {
            try { return JSON.parse(raw) as StoredTokens; } catch { /* malformed */ }
        }
        // Fallback (keyring-less): globalStorage file (survives reload; globalState
        // can be 0-byte on code-server), with globalState as secondary.
        const fallback = readFallbackToken(this.context) ?? this.context.globalState.get<string>(FALLBACK_KEY);
        if (fallback) {
            try { return JSON.parse(fallback) as StoredTokens; } catch { /* malformed */ }
        }
        return undefined;
    }
    private async writeTokens(t: StoredTokens): Promise<void> {
        const payload = JSON.stringify(t);
        await this.context.secrets.store(SECRET_KEY, payload);
        // Probe persistence once so the config banner can warn the user.
        if (this.secretStoragePersists === undefined) {
            const readBack = await this.context.secrets.get(SECRET_KEY);
            // A same-session readback can't prove cross-reload persistence: in
            // code-server (uiKind Web) SecretStorage is in-memory, so it lies here
            // and the token vanishes on reload. Treat web as non-persistent so the
            // token always lands in the globalState fallback (which survives reload).
            this.secretStoragePersists = readBack === payload
                && vscode.env.uiKind !== vscode.UIKind.Web;
        }
        if (this.secretStoragePersists) {
            // Keep the fallback clean while the keyring works.
            writeFallbackToken(this.context, undefined);
            await this.context.globalState.update(FALLBACK_KEY, undefined);
        } else {
            // File fallback is the reliable one on code-server; globalState too.
            writeFallbackToken(this.context, payload);
            await this.context.globalState.update(FALLBACK_KEY, payload);
        }
        this.scheduleRefresh(t.expiresAtMs);   // keep the session alive proactively
    }

    /** Whether SecretStorage persists across restarts (false on snap/code-server);
     *  drives the config warning banner. Probed once, then cached. */
    async isSecretStorageWorking(): Promise<boolean> {
        if (this.secretStoragePersists === undefined) {
            // Throwaway marker under a dedicated key (never SECRET_KEY). Web hosts
            // are non-persistent (in-memory SecretStorage; same-session readback lies).
            const probeKey = SECRET_KEY + ".probe";
            const marker = "symposium-probe";
            await this.context.secrets.store(probeKey, marker);
            this.secretStoragePersists = (await this.context.secrets.get(probeKey)) === marker
                && vscode.env.uiKind !== vscode.UIKind.Web;
            await this.context.secrets.delete(probeKey);
        }
        return this.secretStoragePersists;
    }

    /**
     * Valid access token, auto-refreshing when expired. Returns null when not
     * logged in or when the refresh fails — in which case the dead session is
     * cleared and the user is notified once, so callers never send a dead token.
     */
    async getAccessToken(forceRefresh = false): Promise<string | null> {
        const t = await this.readTokens();
        if (!t) { return null; }
        if (!forceRefresh && Date.now() < t.expiresAtMs - 60_000) {
            this.expiredNoticeShown = false;
            return t.accessToken;
        }
        // Expired or server-rejected: serialize refresh so rotating refresh
        // tokens are not spent twice. forceRefresh is used after an API 401.
        const refreshed = await this.refreshOnce(forceRefresh);
        if (refreshed) { return refreshed.accessToken; }
        await this.clearExpiredSession();
        return null;
    }

    private refreshInFlight?: Promise<StoredTokens | undefined>;
    private async refreshOnce(forceRefresh = false): Promise<StoredTokens | undefined> {
        if (this.refreshInFlight) { return this.refreshInFlight; }
        this.refreshInFlight = (async () => {
            // Re-read: another caller may have refreshed while we queued.
            const cur = await this.readTokens();
            if (!forceRefresh && cur && Date.now() < cur.expiresAtMs - 60_000) { return cur; }
            const rt = cur?.refreshToken;
            if (!rt) { return undefined; }
            try {
                const disco = await this.discovery();
                const res = await fetch(disco.token_endpoint, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: this.clientId() }).toString(),
                });
                if (res.ok) {
                    const nt = this.toStored(await res.json() as { access_token?: string; expires_in?: number; refresh_token?: string; id_token?: string });
                    await this.writeTokens(nt);
                    this.expiredNoticeShown = false;
                    return nt;
                }
                this.log(`[auth] refresh rejected: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
            } catch (err) {
                this.log(`[auth] refresh failed: ${err}`);
            }
            return undefined;
        })();
        try { return await this.refreshInFlight; } finally { this.refreshInFlight = undefined; }
    }

    /** Clears tokens + profile and surfaces the "session expired" notice once. */
    private async clearExpiredSession(): Promise<void> {
        await this.context.secrets.delete(SECRET_KEY);
        writeFallbackToken(this.context, undefined);
        await this.context.globalState.update(FALLBACK_KEY, undefined);
        const hadProfile = !!this.profileCache;
        this.profileCache = undefined;
        await this.context.globalState.update(PROFILE_KEY, undefined);
        this.onChangeEmitter.fire();
        if (hadProfile && !this.expiredNoticeShown) {
            this.expiredNoticeShown = true;
            void vscode.window
                .showWarningMessage(
                    "Sua sessão do Sufficit expirou e não pôde ser renovada automaticamente.",
                    "Entrar novamente",
                )
                .then((choice) => {
                    if (choice === "Entrar novamente") {
                        void vscode.commands.executeCommand("symposium.login");
                    }
                });
        }
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
        await this.context.secrets.delete(SECRET_KEY);
        writeFallbackToken(this.context, undefined);
        await this.context.globalState.update(FALLBACK_KEY, undefined);
        await this.context.globalState.update(PROFILE_KEY, undefined);
        this.profileCache = undefined;
        this.onChangeEmitter.fire();
    }
}
