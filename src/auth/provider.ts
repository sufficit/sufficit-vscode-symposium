import * as vscode from "vscode";
import { SufficitAuth } from "./identity";

/**
 * Native VS Code AuthenticationProvider for Sufficit Identity. Surfaces login,
 * the account label and logout in VS Code's built-in Accounts menu (the avatar
 * icon at the bottom of the activity bar), and lets any code obtain a session
 * via vscode.authentication.getSession("sufficit", ...). Backed by SufficitAuth
 * (OAuth device flow; tokens in SecretStorage).
 */
export class SufficitAuthProvider implements vscode.AuthenticationProvider {
    static readonly id = "sufficit";
    static readonly label = "Sufficit";

    private readonly changeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this.changeEmitter.event;

    constructor(private readonly auth: SufficitAuth) {
        // Bridge SufficitAuth changes to VS Code's session-change event.
        this.auth.onDidChange(async () => {
            const sessions = await this.getSessions();
            this.changeEmitter.fire(sessions.length
                ? { added: sessions, removed: [], changed: [] }
                : { added: [], removed: [], changed: [] });
        });
    }

    /** Registers the provider with VS Code. */
    static register(context: vscode.ExtensionContext, auth: SufficitAuth): SufficitAuthProvider {
        const provider = new SufficitAuthProvider(auth);
        context.subscriptions.push(
            vscode.authentication.registerAuthenticationProvider(
                SufficitAuthProvider.id, SufficitAuthProvider.label, provider,
                { supportsMultipleAccounts: false }),
        );
        return provider;
    }

    private async toSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession | undefined> {
        const token = await this.auth.getAccessToken();
        if (!token) {
            return undefined;
        }
        const p = await this.auth.getProfile();
        return {
            id: SufficitAuthProvider.id,
            accessToken: token,
            account: { id: p?.sub ?? "sufficit", label: p?.name ?? p?.email ?? "Sufficit" },
            scopes: [...scopes],
        };
    }

    async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
        const s = await this.toSession(scopes ?? []);
        return s ? [s] : [];
    }

    async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
        const profile = await this.auth.login();
        const s = await this.toSession(scopes);
        if (!s) {
            throw new Error(profile === undefined ? "Sufficit login cancelled." : "Sufficit login failed.");
        }
        this.changeEmitter.fire({ added: [s], removed: [], changed: [] });
        return s;
    }

    async removeSession(_sessionId: string): Promise<void> {
        const before = await this.toSession([]);
        await this.auth.logout();
        if (before) {
            this.changeEmitter.fire({ added: [], removed: [before], changed: [] });
        }
    }
}
