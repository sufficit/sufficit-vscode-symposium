import type * as vscode from "vscode";
import {
    IDENTITY_FALLBACK_KEY as FALLBACK_KEY,
    IDENTITY_SECRET_KEY as SECRET_KEY,
    StoredTokens,
} from "./identityTypes";
import { SharedIdentityTokenStore } from "./tokenStore";

export function parseStoredTokens(raw: string | undefined): StoredTokens | undefined {
    if (!raw) {
        return undefined;
    }
    try {
        return JSON.parse(raw) as StoredTokens;
    } catch {
        return undefined;
    }
}

export function sameStoredTokenVersion(left: StoredTokens | undefined, right: StoredTokens | undefined): boolean {
    return left?.accessToken === right?.accessToken
        && left?.refreshToken === right?.refreshToken
        && left?.expiresAtMs === right?.expiresAtMs;
}

/** Coordinates the authoritative server-side session used by code-server windows. */
export class SharedIdentitySession {
    private lastPayload: string | undefined;
    private legacyCleanupDone = false;
    private watcher?: { close(): void };

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: SharedIdentityTokenStore,
        private readonly log: (message: string) => void,
    ) { }

    async read(): Promise<StoredTokens | undefined> {
        const shared = this.store.read();
        if (shared) {
            this.lastPayload = shared;
            try { this.store.initialize(); } catch (error) {
                this.log(`[auth] unable to initialize shared token metadata: ${error}`);
            }
            await this.cleanupLegacyBrowserStorage();
            return parseStoredTokens(shared);
        }
        this.lastPayload = undefined;
        if (this.store.isInitialized()) {
            return undefined;
        }

        const legacy = await this.context.secrets.get(SECRET_KEY)
            ?? this.context.globalState.get<string>(FALLBACK_KEY);
        if (!legacy || !parseStoredTokens(legacy)) {
            return undefined;
        }
        try {
            const migrated = await this.store.withLock(() => {
                const current = this.store.read();
                if (current) { return current; }
                if (this.store.isInitialized()) { return undefined; }
                this.store.write(legacy);
                return legacy;
            });
            this.lastPayload = migrated;
            await this.cleanupLegacyBrowserStorage();
            return parseStoredTokens(migrated);
        } catch (error) {
            this.log(`[auth] shared token migration failed: ${error}`);
            return undefined;
        }
    }

    readCurrent(): StoredTokens | undefined {
        const raw = this.store.read();
        this.lastPayload = raw;
        return parseStoredTokens(raw);
    }

    async write(payload: string, lockHeld: boolean): Promise<void> {
        const persist = () => {
            this.lastPayload = payload;
            this.store.write(payload);
        };
        if (lockHeld) { persist(); } else { await this.store.withLock(persist); }
        await this.cleanupLegacyBrowserStorage();
    }

    async clear(expected?: StoredTokens): Promise<boolean> {
        let cleared = false;
        await this.store.withLock(() => {
            const current = this.readCurrent();
            if (expected && !sameStoredTokenVersion(expected, current)) { return; }
            this.lastPayload = undefined;
            this.store.write(undefined);
            cleared = true;
        });
        return cleared;
    }

    withLock<T>(action: () => Promise<T> | T): Promise<T> {
        return this.store.withLock(action);
    }

    watch(listener: (tokens: StoredTokens | undefined) => void): void {
        this.watcher?.close();
        this.watcher = this.store.watch(() => {
            const payload = this.store.read();
            if (payload === this.lastPayload) { return; }
            this.lastPayload = payload;
            listener(parseStoredTokens(payload));
        });
    }

    dispose(): void {
        this.watcher?.close();
    }

    private async cleanupLegacyBrowserStorage(): Promise<void> {
        if (this.legacyCleanupDone) { return; }
        this.legacyCleanupDone = true;
        await this.context.secrets.delete(SECRET_KEY);
        await this.context.globalState.update(FALLBACK_KEY, undefined);
    }
}
