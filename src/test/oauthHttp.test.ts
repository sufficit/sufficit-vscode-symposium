import * as assert from "node:assert/strict";
import { test } from "node:test";
import { pollDeviceToken } from "../auth/identityDeviceFlow";
import { isTransientOAuthStatus, OAuthHttpError, parseOAuthJson } from "../auth/oauthHttp";

test("OAuth JSON parser accepts valid JSON even with an incorrect content type", async () => {
    const response = new Response('{"access_token":"token"}', {
        status: 200,
        headers: { "content-type": "text/plain" },
    });
    assert.deepEqual(await parseOAuthJson(response, "token endpoint"), { access_token: "token" });
});

test("OAuth JSON parser reports safe HTTP context instead of Unexpected token", async () => {
    const response = new Response(
        "<html><head><style>secret{}</style></head><body><h1>Bad Gateway</h1></body></html>",
        {
            status: 502,
            headers: { "content-type": "text/html; charset=utf-8" },
        },
    );

    await assert.rejects(
        parseOAuthJson(response, "Sufficit device token endpoint"),
        (error: unknown) => {
            assert.ok(error instanceof OAuthHttpError);
            assert.equal(error.status, 502);
            assert.equal(error.transient, true);
            assert.match(error.message, /device token endpoint.*HTTP 502.*text\/html.*Bad Gateway/);
            assert.doesNotMatch(error.message, /Unexpected token|secret\{\}/);
            return true;
        },
    );
});

test("OAuth JSON parser classifies permanent non-JSON responses", async () => {
    await assert.rejects(
        parseOAuthJson(
            new Response("<html>Bad Request</html>", { status: 400 }),
            "authorization endpoint",
        ),
        (error: unknown) =>
            error instanceof OAuthHttpError && !error.transient && error.status === 400,
    );
    assert.equal(isTransientOAuthStatus(429), true);
    assert.equal(isTransientOAuthStatus(503), true);
    assert.equal(isTransientOAuthStatus(401), false);
});

test("Device Flow polling survives a transient HTML proxy response", async () => {
    const responses = [
        new Response("<html><h1>Service Unavailable</h1></html>", { status: 503 }),
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 429 }),
        new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
        new Response(JSON.stringify({ access_token: "ready", expires_in: 3600 }), { status: 200 }),
    ];
    const logs: string[] = [];
    let now = 0;
    const result = await pollDeviceToken({
        tokenEndpoint: "https://identity.example/connect/token",
        clientId: "client",
        deviceCode: "device",
        intervalSec: 1,
        expiresInSec: 30,
        fetchImpl: (() => Promise.resolve(responses.shift()!)) as typeof fetch,
        sleep: (milliseconds) => {
            now += milliseconds;
            return Promise.resolve();
        },
        now: () => now,
        log: (message) => logs.push(message),
    });

    assert.equal(result?.access_token, "ready");
    assert.equal(responses.length, 0);
    assert.match(logs.join("\n"), /HTTP 503.*polling will continue/);
    assert.match(logs.join("\n"), /HTTP 429.*polling will continue/);
});

test("Device Flow polling does not retry a permanent OAuth error", async () => {
    let calls = 0;
    await assert.rejects(
        pollDeviceToken({
            tokenEndpoint: "https://identity.example/connect/token",
            clientId: "client",
            deviceCode: "device",
            intervalSec: 1,
            expiresInSec: 30,
            fetchImpl: (() => {
                calls += 1;
                return Promise.resolve(
                    new Response(
                        JSON.stringify({ error: "access_denied", error_description: "Denied" }),
                        { status: 400 },
                    ),
                );
            }) as typeof fetch,
            sleep: () => Promise.resolve(),
        }),
        /Denied/,
    );
    assert.equal(calls, 1);
});
