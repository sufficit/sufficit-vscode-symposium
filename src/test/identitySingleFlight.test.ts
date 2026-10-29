import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SufficitAuth } from "../auth/identity";
import { fetchSufficitProfile, ProfileChangeGate } from "../auth/identityProfile";
import { DEFAULT_IDENTITY_SCOPE } from "../auth/identityScopes";
import {
    IDENTITY_PROFILE_KEY as PROFILE_KEY,
    IDENTITY_SECRET_KEY as SECRET_KEY,
    SufficitProfile,
} from "../auth/identityTypes";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const DISCOVERY = JSON.stringify({ userinfo_endpoint: "https://identity.test/userinfo" });
const LIVE_PROFILE = JSON.stringify({ sub: "sub-1", name: "Live Profile" });

/** Minimal EventEmitter double so tests observe real onDidChange transitions. */
class RecordingEmitter {
    private listeners: (() => void)[] = [];
    fires = 0;
    readonly event = (listener: () => void) => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter((current) => current !== listener);
            },
        };
    };
    fire(): void {
        this.fires += 1;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
    dispose(): void {
        this.listeners = [];
    }
}

function fakeContext(tokens: object | undefined): vscode.ExtensionContext {
    const state = new Map<string, unknown>([
        [PROFILE_KEY, { sub: "sub-1", name: "Saved Profile", email: "saved@example.test" }],
    ]);
    return {
        globalState: {
            get: (key: string) => state.get(key),
            update: (key: string, value: unknown) => {
                state.set(key, value);
                return Promise.resolve();
            },
        },
        secrets: {
            get: (key: string) =>
                key === SECRET_KEY && tokens ? JSON.stringify(tokens) : undefined,
            store: () => Promise.resolve(),
            delete: () => Promise.resolve(),
        },
        globalStorageUri: {
            fsPath: fs.mkdtempSync(path.join(os.tmpdir(), "symposium-auth-dedupe-")),
        },
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

const freshTokens = () => ({
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    scope: DEFAULT_IDENTITY_SCOPE,
    expiresAtMs: Date.now() + 3_600_000,
});

async function withAuth(
    tokens: object | undefined,
    run: (auth: SufficitAuth, emitter: RecordingEmitter) => Promise<void>,
): Promise<void> {
    const mutable = vscode as unknown as { EventEmitter: unknown };
    const original = mutable.EventEmitter;
    let emitter: RecordingEmitter | undefined;
    mutable.EventEmitter = class extends RecordingEmitter {
        constructor() {
            super();
            emitter ??= this;
        }
    };
    try {
        const auth = new SufficitAuth(fakeContext(tokens), () => undefined);
        assert.ok(emitter, "SufficitAuth did not construct the recording emitter");
        await run(auth, emitter);
    } finally {
        mutable.EventEmitter = original;
    }
}

function mockIdentityFetch(t: {
    mock: {
        method: (
            object: typeof globalThis,
            name: "fetch",
            impl: (input: unknown) => Promise<Response>,
        ) => unknown;
    };
}, userinfo: (request: number) => Response): { userinfoRequests: () => number } {
    let userinfoRequests = 0;
    t.mock.method(globalThis, "fetch", async (input: unknown) => {
        const url = String(input);
        if (url.includes("openid-configuration")) {
            return new Response(DISCOVERY, { status: 200 });
        }
        userinfoRequests += 1;
        return userinfo(userinfoRequests);
    });
    return { userinfoRequests: () => userinfoRequests };
}

test("concurrent getProfile(true) callers share one userinfo request", async (t) => {
    const { userinfoRequests } = mockIdentityFetch(t, () => new Response(LIVE_PROFILE, {
        status: 200,
    }));
    await withAuth(freshTokens(), async (auth) => {
        const results = await Promise.all([
            auth.getProfile(true),
            auth.getProfile(true),
            auth.getProfile(true),
            auth.getProfile(true),
        ]);
        assert.equal(userinfoRequests(), 1);
        assert.ok(results.every((profile) => profile?.name === "Live Profile"));
        await auth.getProfile(true);
        assert.equal(userinfoRequests(), 2);
    });
});

test("startup restore publishes a single effective onDidChange transition", async (t) => {
    const { userinfoRequests } = mockIdentityFetch(t, () => new Response(LIVE_PROFILE, {
        status: 200,
    }));
    await withAuth(freshTokens(), async (auth, emitter) => {
        const restored = await auth.getProfile(false);
        assert.equal(restored?.name, "Saved Profile");
        // The deferred force-fetch races with other forced callers; all of
        // them must still share one request and publish one transition.
        await Promise.all([auth.getProfile(true), auth.getProfile(true), auth.getProfile(true)]);
        await flush();
        await flush();
        assert.equal(userinfoRequests(), 1);
        assert.equal(emitter.fires, 1);
    });
});

test("transient userinfo failure keeps the cached profile", async (t) => {
    mockIdentityFetch(t, () => new Response("temporarily unavailable", { status: 503 }));
    await withAuth(freshTokens(), async (auth) => {
        await auth.getProfile(false); // primes profileCache from persisted state
        const profile = await auth.getProfile(true);
        assert.equal(profile?.name, "Saved Profile");
    });
});

test("ProfileChangeGate collapses concurrent notifies into one fire", async () => {
    let fires = 0;
    const gate = new ProfileChangeGate({
        fire: () => {
            fires += 1;
        },
    });
    const profile: SufficitProfile = { sub: "sub-1", name: "Live Profile" };
    let release: (() => void) | undefined;
    const task = () =>
        new Promise<SufficitProfile | undefined>((resolve) => {
            release = () => resolve(profile);
        });
    const shared = [gate.run(task), gate.run(task), gate.run(task)];
    gate.notify();
    gate.notify();
    gate.notify();
    await flush();
    assert.equal(fires, 1);
    release!();
    assert.deepEqual(await Promise.all(shared), [profile, profile, profile]);
    await flush();
    assert.equal(fires, 1);
});

test("fetchSufficitProfile maps sub to the contact avatar and keeps fallbacks", async (t) => {
    const seen: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: unknown) => {
        const url = String(input);
        seen.push(url);
        if (url.includes("openid-configuration")) {
            return new Response(DISCOVERY, { status: 200 });
        }
        return new Response(
            JSON.stringify({ sub: "user 42", preferred_username: "u42", email: "u@t" }),
            { status: 200 },
        );
    });
    const profile = await fetchSufficitProfile(
        "https://identity.test",
        "token",
        async () => JSON.parse(DISCOVERY),
    );
    assert.equal(profile?.name, "u42");
    assert.equal(
        profile?.picture,
        "https://endpoints.sufficit.com.br/contact/avatar?contextid=user%2042",
    );
    assert.deepEqual(seen, ["https://identity.test/userinfo"]);
});

test("fetchSufficitProfile returns undefined when userinfo rejects", async (t) => {
    t.mock.method(globalThis, "fetch", async (input: unknown) => {
        const url = String(input);
        if (url.includes("openid-configuration")) {
            return new Response(DISCOVERY, { status: 200 });
        }
        return new Response("nope", { status: 401 });
    });
    const profile = await fetchSufficitProfile(
        "https://identity.test",
        "token",
        async () => JSON.parse(DISCOVERY),
    );
    assert.equal(profile, undefined);
});
