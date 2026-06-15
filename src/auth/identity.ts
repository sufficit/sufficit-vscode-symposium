import * as vscode from "vscode";
import { createHash, randomBytes } from "crypto";

/**
 * Sufficit Identity login for Symposium via the sufficit-ai OAuth proxy
 * (Duende IdentityServer behind ai.sufficit.com.br). Authorization Code + PKCE
 * with a VS Code URI redirect; tokens are kept in SecretStorage (never in
 * settings.json). The profile (name/email/avatar) comes from /connect/userinfo.
 *
 * These credentials are the basis for memory/MCP access (next slice wires the
 * access token into the hub requests).
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

const SECRET_KEY = "sufficit.identity.tokens";
const REDIRECT_PATH = "/auth-callback";

export class SufficitAuth {
    private profileCache: SufficitProfile | undefined;
    private readonly onChangeEmitter = new vscode.EventEmitter<void>();
    /** Fires on login/logout so the UI can refresh. */
    readonly onDidChange = this.onChangeEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: (msg: string) => void = () => { },
    ) { }

    /** Base of the sufficit-ai gateway / OAuth proxy. */
    private base(): string {
        return vscode.workspace.getConfiguration("symposium.hub").get<string>("url", "").replace(/\/+$/, "");
    }

    private redirectUri(): string {
        return `${vscode.env.uriScheme}://sufficit.sufficit-vscode-symposium${REDIRECT_PATH}`;
    }

    /** Loads the OIDC discovery document from the proxy. */
    private async discovery(): Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string; registration_endpoint?: string }> {
        const res = await fetch(`${this.base()}/.well-known/openid-configuration`);
        if (!res.ok) {
            throw new Error(`discovery failed: ${res.status}`);
        }
        return (await res.json()) as any;
    }

    /** Registers a public PKCE client with our redirect, returning a client_id. */
    private async registerClient(registrationEndpoint: string): Promise<string> {
        const res = await fetch(registrationEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                client_name: "Symposium (VS Code)",
                redirect_uris: [this.redirectUri()],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
            }),
        });
        if (!res.ok) {
            throw new Error(`client registration failed: ${res.status}`);
        }
        const j = (await res.json()) as { client_id: string };
        return j.client_id;
    }

    /** Whether a (possibly expired) session is stored. */
    async isLoggedIn(): Promise<boolean> {
        return (await this.readTokens()) !== undefined;
    }

    /** Runs the interactive login. Returns the profile on success. */
    async login(): Promise<SufficitProfile | undefined> {
        if (!this.base()) {
            void vscode.window.showWarningMessage("Configure symposium.hub.url antes do login.");
            return undefined;
        }
        const disco = await this.discovery();
        const clientId = disco.registration_endpoint
            ? await this.registerClient(disco.registration_endpoint).catch(() => "mcp_vscode_proxy")
            : "mcp_vscode_proxy";

        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const state = randomBytes(16).toString("base64url");

        const code = await this.authorizeViaBrowser(disco.authorization_endpoint, clientId, challenge, state);
        if (!code) {
            return undefined;
        }
        const tokens = await this.exchangeCode(disco.token_endpoint, clientId, code, verifier);
        await this.writeTokens(tokens);
        this.profileCache = undefined;
        const profile = await this.getProfile(true);
        this.onChangeEmitter.fire();
        return profile;
    }

    /** Opens the browser to the authorize URL and waits for the redirect code. */
    private authorizeViaBrowser(authEndpoint: string, clientId: string, challenge: string, state: string): Promise<string | undefined> {
        const params = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: this.redirectUri(),
            scope: "openid profile email offline_access",
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
        });
        const url = `${authEndpoint}?${params.toString()}`;

        return new Promise<string | undefined>((resolve) => {
            const disposable = vscode.window.registerUriHandler({
                handleUri: (uri: vscode.Uri) => {
                    if (!uri.path.startsWith(REDIRECT_PATH)) {
                        return;
                    }
                    const q = new URLSearchParams(uri.query);
                    if (q.get("state") !== state) {
                        resolve(undefined);
                    } else {
                        resolve(q.get("code") ?? undefined);
                    }
                    disposable.dispose();
                },
            });
            const timer = setTimeout(() => { disposable.dispose(); resolve(undefined); }, 300_000);
            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: "Sufficit: aguardando login no navegador…" },
                () => new Promise<void>((done) => {
                    const i = setInterval(() => { /* keep notification while waiting */ }, 1000);
                    const stop = () => { clearInterval(i); clearTimeout(timer); done(); };
                    this.context.subscriptions.push({ dispose: stop });
                    setTimeout(stop, 300_000);
                }));
            void vscode.env.openExternal(vscode.Uri.parse(url));
        });
    }

    private async exchangeCode(tokenEndpoint: string, clientId: string, code: string, verifier: string): Promise<StoredTokens> {
        const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: this.redirectUri(),
            client_id: clientId,
            code_verifier: verifier,
        });
        const res = await fetch(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
        if (!res.ok) {
            throw new Error(`token exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
        }
        return this.toStored(await res.json());
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
        if (!raw) {
            return undefined;
        }
        try { return JSON.parse(raw) as StoredTokens; } catch { return undefined; }
    }

    private async writeTokens(t: StoredTokens): Promise<void> {
        await this.context.secrets.store(SECRET_KEY, JSON.stringify(t));
    }

    /** Returns a valid access token, refreshing if needed; null if not logged in. */
    async getAccessToken(): Promise<string | null> {
        let t = await this.readTokens();
        if (!t) {
            return null;
        }
        if (Date.now() < t.expiresAtMs - 60_000) {
            return t.accessToken;
        }
        if (t.refreshToken) {
            try {
                const disco = await this.discovery();
                const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: "mcp_vscode_proxy" });
                const res = await fetch(disco.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
                if (res.ok) {
                    t = this.toStored(await res.json());
                    await this.writeTokens(t);
                    return t.accessToken;
                }
            } catch (err) {
                this.log(`[auth] refresh failed: ${err}`);
            }
        }
        return t.accessToken; // possibly expired; caller handles 401
    }

    /** Profile from userinfo (cached). */
    async getProfile(force = false): Promise<SufficitProfile | undefined> {
        if (this.profileCache && !force) {
            return this.profileCache;
        }
        const token = await this.getAccessToken();
        if (!token) {
            return undefined;
        }
        try {
            const res = await fetch(`${this.base()}/connect/userinfo`, { headers: { authorization: `Bearer ${token}` } });
            if (!res.ok) {
                return undefined;
            }
            const j = (await res.json()) as any;
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
