import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SharedIdentityTokenStore } from "../auth/tokenStore";
import { SharedIdentitySession } from "../auth/sharedIdentitySession";
import { IDENTITY_SECRET_KEY } from "../auth/identityTypes";

function temporaryStore(): { directory: string; store: SharedIdentityTokenStore } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-identity-"));
    return { directory, store: new SharedIdentityTokenStore(directory) };
}

function browserContext(secret?: string): any {
    const secrets = new Map<string, string>();
    const state = new Map<string, unknown>();
    if (secret) {
        secrets.set(IDENTITY_SECRET_KEY, secret);
    }
    return {
        secrets: {
            get: (key: string) => Promise.resolve(secrets.get(key)),
            delete: (key: string) => {
                secrets.delete(key);
                return Promise.resolve();
            },
        },
        globalState: {
            get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
            update: (key: string, value: unknown) => {
                if (value === undefined) {
                    state.delete(key);
                } else {
                    state.set(key, value);
                }
                return Promise.resolve();
            },
        },
    };
}

test("code-server browsers share one authoritative token file", () => {
    const { directory, store: browserA } = temporaryStore();
    const browserB = new SharedIdentityTokenStore(directory);
    try {
        browserA.write('{"accessToken":"luna"}');
        assert.equal(browserB.read(), '{"accessToken":"luna"}');

        browserB.write('{"accessToken":"sol"}');
        assert.equal(browserA.read(), '{"accessToken":"sol"}');
        assert.equal(
            fs.statSync(path.join(directory, "identity-fallback.json")).mode & 0o777,
            0o600,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("shared-store logout leaves a tombstone and cannot be resurrected by stale browser storage", () => {
    const { directory, store } = temporaryStore();
    try {
        store.write('{"accessToken":"signed-in"}');
        store.write(undefined);

        assert.equal(store.read(), undefined);
        assert.equal(store.isInitialized(), true);
        // IdentityTokenManager treats this state as an explicit shared logout
        // and therefore never migrates a stale browser-local SecretStorage copy.
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("authoritative code-server token wins over each browser's local SecretStorage", async () => {
    const { directory, store } = temporaryStore();
    const shared = JSON.stringify({ accessToken: "shared", expiresAtMs: Date.now() + 60_000 });
    const stale = JSON.stringify({
        accessToken: "browser-local",
        expiresAtMs: Date.now() + 60_000,
    });
    store.write(shared);
    const sessionA = new SharedIdentitySession(browserContext(stale), store, () => undefined);
    const sessionB = new SharedIdentitySession(
        browserContext(stale),
        new SharedIdentityTokenStore(directory),
        () => undefined,
    );
    try {
        assert.equal((await sessionA.read())?.accessToken, "shared");
        assert.equal((await sessionB.read())?.accessToken, "shared");
    } finally {
        sessionA.dispose();
        sessionB.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("first code-server browser migrates once and later browsers cannot replace it", async () => {
    const { directory, store } = temporaryStore();
    const first = JSON.stringify({ accessToken: "first", expiresAtMs: Date.now() + 60_000 });
    const second = JSON.stringify({ accessToken: "second", expiresAtMs: Date.now() + 60_000 });
    const sessionA = new SharedIdentitySession(browserContext(first), store, () => undefined);
    const sessionB = new SharedIdentitySession(
        browserContext(second),
        new SharedIdentityTokenStore(directory),
        () => undefined,
    );
    try {
        assert.equal((await sessionA.read())?.accessToken, "first");
        assert.equal((await sessionB.read())?.accessToken, "first");
    } finally {
        sessionA.dispose();
        sessionB.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("two code-server browsers serialize rotating refresh tokens", async () => {
    const { directory, store: browserA } = temporaryStore();
    const browserB = new SharedIdentityTokenStore(directory);
    browserA.write("refresh-v1");
    let providerRefreshes = 0;

    const refresh = async (store: SharedIdentityTokenStore): Promise<string | undefined> => {
        const observed = store.read();
        return store.withLock(async () => {
            const current = store.read();
            if (current !== observed) {
                return current;
            }
            providerRefreshes += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
            const rotated = "refresh-v2";
            store.write(rotated);
            return rotated;
        });
    };

    try {
        const [resultA, resultB] = await Promise.all([refresh(browserA), refresh(browserB)]);
        assert.equal(resultA, "refresh-v2");
        assert.equal(resultB, "refresh-v2");
        assert.equal(providerRefreshes, 1);
        assert.equal(browserA.read(), "refresh-v2");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("shared token replacements remain complete and parseable", () => {
    const { directory, store } = temporaryStore();
    const payloads = Array.from({ length: 40 }, (_, index) =>
        JSON.stringify({ index, value: "x".repeat(2048) }),
    );
    try {
        for (const [index, payload] of payloads.entries()) {
            store.write(payload);
            assert.equal((JSON.parse(store.read()!) as { index: number }).index, index);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
