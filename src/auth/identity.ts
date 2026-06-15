import * as vscode from "vscode";

/**
 * Sufficit Identity login for Symposium via OAuth 2.0 Device Authorization Grant
 * against the Duende IdentityServer at identity.sufficit.com.br. Device flow is
 * used because it needs no redirect URI — works in desktop VS Code and code-server.
 *
 * Tokens live in SecretStorage (never settings.json). The profile (name/email/
 * avatar) comes from /connect/userinfo. These credentials are the basis for
 * memory/MCP access.
 *
 * Requires a public OAuth client registered in identity with the device_code
 * grant enabled and scopes openid/profile/email/offline_access. The client id is
 * read from `symposium.identity.clientId`.
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

export class SufficitAuth {
    private profileCache: SufficitProfile | undefined;
    private readonly onChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onChangeEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: (msg: string) => void = () => { },
    ) { }

    private cfg() {
        return vscode.workspace.getConfiguration("symposium.identity");
    }
    private issuer(): string {
        const v = this.cfg().get<string>("url", "");
        return (v && v.trim() ? v : "https://identity.sufficit.com.br").replace(/\/+$/, "");
    }
    private clientId(): string {
        return this.cfg().get<string>("clientId", "");
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

    /** Interactive device-code login. Returns the profile on success. */
    async login(): Promise<SufficitProfile | undefined> {
        const clientId = this.clientId();
        if (!clientId) {
            void vscode.window.showErrorMessage("Configure symposium.identity.clientId (client OAuth registrado no Sufficit Identity).");
            return undefined;
        }
        const disco = await this.discovery();
        if (!disco.device_authorization_endpoint) {
            throw new Error("Identity não anuncia device_authorization_endpoint.");
        }

        // 1. Request a device + user code.
        const devRes = await fetch(disco.device_authorization_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, scope: this.scope() }).toString(),
        });
        const dev = await devRes.json() as any;
        if (!devRes.ok) {
            throw new Error(`device authorization failed: ${dev.error ?? devRes.status}`);
        }

        const verifyUrl: string = dev.verification_uri_complete ?? dev.verification_uri;
        const pick = await vscode.window.showInformationMessage(
            `Sufficit: abra o navegador e confirme o código ${dev.user_code}`, "Abrir navegador");
        if (pick) {
            await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));
        }

        // 2. Poll the token endpoint until the user approves (or timeout).
        const tokens = await this.pollToken(disco.token_endpoint, clientId, dev.device_code, dev.interval ?? 5, dev.expires_in ?? 300);
        if (!tokens) {
            return undefined;
        }
        await this.writeTokens(tokens);
        this.profileCache = undefined;
        const profile = await this.getProfile(true);
        this.onChangeEmitter.fire();
        return profile;
    }

    private async pollToken(tokenEndpoint: string, clientId: string, deviceCode: string, intervalSec: number, expiresInSec: number): Promise<StoredTokens | undefined> {
        const deadline = Date.now() + expiresInSec * 1000;
        let interval = intervalSec;
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Sufficit: aguardando aprovação no navegador…", cancellable: true },
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
                    const j = await res.json() as any;
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

    private toStored(j: any): StoredTokens {
        return {
            accessToken: j.access_token,
            refreshToken: j.refresh_token,
            idToken: j.id_token,
            expiresAtMs: Date.now() + ((j.expires_in ?? 3600) * 1000),
        };
    }

    private async readTokens(): Promise<StoredTokens | undefined> {
        const raw = await this.context.secrets.get(SECRET_KEY);
        if (!raw) { return undefined; }
        try { return JSON.parse(raw) as StoredTokens; } catch { return undefined; }
    }
    private async writeTokens(t: StoredTokens): Promise<void> {
        await this.context.secrets.store(SECRET_KEY, JSON.stringify(t));
    }

    /** Valid access token (refreshes when possible); null if not logged in. */
    async getAccessToken(): Promise<string | null> {
        let t = await this.readTokens();
        if (!t) { return null; }
        if (Date.now() < t.expiresAtMs - 60_000) { return t.accessToken; }
        if (t.refreshToken) {
            try {
                const disco = await this.discovery();
                const res = await fetch(disco.token_endpoint, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: this.clientId() }).toString(),
                });
                if (res.ok) { t = this.toStored(await res.json()); await this.writeTokens(t); return t.accessToken; }
            } catch (err) {
                this.log(`[auth] refresh failed: ${err}`);
            }
        }
        return t.accessToken;
    }

    async getProfile(force = false): Promise<SufficitProfile | undefined> {
        if (this.profileCache && !force) { return this.profileCache; }
        const token = await this.getAccessToken();
        if (!token) { return undefined; }
        try {
            const disco = await this.discovery();
            const res = await fetch(disco.userinfo_endpoint ?? `${this.issuer()}/connect/userinfo`, { headers: { authorization: `Bearer ${token}` } });
            if (!res.ok) { return undefined; }
            const j = await res.json() as any;
            this.profileCache = { sub: j.sub, name: j.name ?? j.preferred_username, email: j.email, picture: j.picture };
            return this.profileCache;
        } catch {
            return undefined;
        }
    }

    async logout(): Promise<void> {
        await this.context.secrets.delete(SECRET_KEY);
        this.profileCache = undefined;
        this.onChangeEmitter.fire();
    }
}
