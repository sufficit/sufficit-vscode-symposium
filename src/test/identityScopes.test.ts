import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
    DEFAULT_IDENTITY_SCOPE,
    hasRequestedIdentityScopes,
    normalizeIdentityScope,
} from "../auth/identityScopes";

test("default Identity scopes include authorization claims", () => {
    assert.equal(
        normalizeIdentityScope(),
        "openid profile email roles directives offline_access",
    );
    assert.equal(normalizeIdentityScope(), DEFAULT_IDENTITY_SCOPE);
});

test("custom Identity scopes retain order and receive required authorization scopes", () => {
    assert.equal(
        normalizeIdentityScope("openid profile offline_access"),
        "openid profile offline_access roles directives",
    );
});

test("scope validation rejects legacy grants and accepts the upgraded grant", () => {
    assert.equal(
        hasRequestedIdentityScopes(
            "openid profile email offline_access",
            DEFAULT_IDENTITY_SCOPE,
        ),
        false,
    );
    assert.equal(
        hasRequestedIdentityScopes(DEFAULT_IDENTITY_SCOPE, DEFAULT_IDENTITY_SCOPE),
        true,
    );
});
