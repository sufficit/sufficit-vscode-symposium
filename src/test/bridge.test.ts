import { test } from "node:test";
import assert from "node:assert/strict";
import { isBridgeAuthorized } from "../api/bridgeAuth";
import { decodeBridgePathSegment } from "../api/bridgeRoutes";

test("bridge query token is accepted only for session follow SSE", () => {
    const token = "secret-token";

    assert.equal(
        isBridgeAuthorized(
            undefined,
            new URL(`http://localhost/sessions/abc/follow?token=${token}`),
            token,
        ),
        true,
    );
    assert.equal(
        isBridgeAuthorized(
            undefined,
            new URL(`http://localhost/sessions/abc/follow/?token=${token}`),
            token,
        ),
        true,
    );
    assert.equal(
        isBridgeAuthorized(
            undefined,
            new URL(`http://localhost/vault/resolve?reference=x&token=${token}`),
            token,
        ),
        false,
    );
    assert.equal(
        isBridgeAuthorized(undefined, new URL(`http://localhost/sessions?token=${token}`), token),
        false,
    );
});

test("bridge authorization header works for every endpoint", () => {
    const token = "secret-token";

    assert.equal(
        isBridgeAuthorized(
            `Bearer ${token}`,
            new URL("http://localhost/vault/resolve?reference=x"),
            token,
        ),
        true,
    );
});

test("X-Symposium-Token header authorizes without colliding with Authorization", () => {
    const token = "secret-token";
    const url = new URL("http://localhost/sessions");

    // Bridge token in the dedicated header, Authorization free for a Basic gate.
    assert.equal(isBridgeAuthorized("Basic dXNlcjpwYXNz", url, token, token), true);
    // Wrong custom token is rejected.
    assert.equal(isBridgeAuthorized(undefined, url, token, "nope"), false);
    // Array header (duplicated) does not match.
    assert.equal(isBridgeAuthorized(undefined, url, token, [token] as unknown as string[]), false);
});

test("bridge decodes slash-containing subagent ids from one URL segment", () => {
    assert.equal(
        decodeBridgePathSegment("parent%2Fsubagents%2Fagent-123"),
        "parent/subagents/agent-123",
    );
    assert.equal(decodeBridgePathSegment("bad%escape"), undefined);
});
