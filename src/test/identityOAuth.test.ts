import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
    buildHeaders,
    shouldRefreshNativeAuthorization,
} from "../adapters/openai/httpAuth";
import { OpenAIAdapterConfig } from "../adapters/openai/types";
import {
    buildPkceAuthorizationUrl,
    identityRedirectUri,
} from "../auth/identityOAuth";

const adapterConfig: OpenAIAdapterConfig = {
    api: "responses",
    baseUrl: "https://ai.sufficit.com.br/openai/v1",
    model: "test-model",
    models: [],
    headers: {},
};

test("Identity callback uses the registered extension authority", () => {
    assert.equal(
        identityRedirectUri("vscode"),
        "vscode://sufficit.sufficit-vscode-symposium/callback",
    );
    assert.equal(
        identityRedirectUri("vscode-insiders"),
        "vscode-insiders://sufficit.sufficit-vscode-symposium/callback",
    );
});

test("PKCE authorization URL carries the complete public-client contract", () => {
    const url = buildPkceAuthorizationUrl({
        endpoint: "https://identity.sufficit.com.br/connect/authorize",
        clientId: "sufficit-vscode-symposium",
        redirectUri: identityRedirectUri("vscode"),
        scope: "openid profile roles directives offline_access",
        challenge: "challenge",
        state: "state",
    });

    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "sufficit-vscode-symposium");
    assert.equal(url.searchParams.get("redirect_uri"), identityRedirectUri("vscode"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge"), "challenge");
    assert.equal(url.searchParams.get("state"), "state");
    assert.equal(url.searchParams.has("client_secret"), false);
});

test("Sufficit AI requests use the Identity token without overriding explicit auth", () => {
    assert.equal(buildHeaders(adapterConfig, "identity-token").authorization, "Bearer identity-token");

    const explicit = buildHeaders({
        ...adapterConfig,
        headers: { Authorization: "Bearer explicit-token" },
    }, "identity-token");
    assert.equal(explicit.Authorization, "Bearer explicit-token");
    assert.equal(explicit.authorization, undefined);

    const apiKey = buildHeaders({ ...adapterConfig, apiKey: "api-key" }, "identity-token");
    assert.equal(apiKey.authorization, "Bearer api-key");
});

test("native Sufficit auth refreshes once for 401 and directive-related 403 responses", () => {
    assert.equal(shouldRefreshNativeAuthorization(401, true, "token"), true);
    assert.equal(shouldRefreshNativeAuthorization(403, true, "token"), true);
    assert.equal(shouldRefreshNativeAuthorization(403, false, "token"), false);
    assert.equal(shouldRefreshNativeAuthorization(403, true, null), false);
    assert.equal(shouldRefreshNativeAuthorization(500, true, "token"), false);
});

test("desktop PKCE arms the callback before opening and awaiting the browser flow", () => {
    const source = readFileSync(resolve(__dirname, "../../src/auth/identity.ts"), "utf8");
    const promiseAt = source.indexOf("const authCodePromise = new Promise<string>");
    const openAt = source.indexOf("await vscode.env.openExternal", promiseAt);
    const awaitAt = source.indexOf("const authCode = await authCodePromise", openAt);

    assert.ok(promiseAt >= 0, "PKCE callback promise must be created");
    assert.ok(openAt > promiseAt, "callback state must be armed before the browser opens");
    assert.ok(awaitAt > openAt, "login must open the browser before awaiting its callback");
});
