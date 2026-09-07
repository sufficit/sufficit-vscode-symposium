import type * as http from "http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBridgeAuthorized } from "../api/bridgeAuth";
import { handleBridgeRequest } from "../api/bridgeRequest";
import { decodeBridgePathSegment } from "../api/bridgeRoutes";
import { createSymposiumDiscovery, createSymposiumOpenApi } from "../api/discovery";
import { SYMPOSIUM_FEATURE_VERSIONS } from "../features";

test("bridge rejects query-string credentials", () => {
    const token = "secret-token";

    assert.equal(
        isBridgeAuthorized(
            undefined,
            new URL(`http://localhost/sessions/abc/follow?token=${token}`),
            token,
        ),
        false,
    );
    assert.equal(
        isBridgeAuthorized(
            undefined,
            new URL(`http://localhost/sessions/abc/follow/?token=${token}`),
            token,
        ),
        false,
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

test("bridge discovery advertises the current AHP and HTTP contracts", () => {
    const manifest = createSymposiumDiscovery("1.0.0", ["symposium.resources.v1"]);
    const protocols = manifest.protocols as {
        ahp: { endpoint: string; versions: string[]; methods: string[] };
        http: { openapi: string };
    };
    assert.equal(protocols.ahp.endpoint, "/ahp");
    assert.ok(protocols.ahp.versions.includes("0.6.0"));
    assert.ok(protocols.ahp.methods.includes("initialize"));
    assert.equal(protocols.http.openapi, "/openapi.json");
    assert.deepEqual(manifest.capabilities, ["symposium.discovery.v1", "symposium.resources.v1"]);
    assert.equal(manifest.features, SYMPOSIUM_FEATURE_VERSIONS);

    const openapi = createSymposiumOpenApi("1.0.0") as {
        openapi: string;
        info: { "x-symposium-feature-versions": unknown };
        paths: Record<string, unknown>;
    };
    assert.equal(openapi.openapi, "3.1.0");
    assert.equal(openapi.info["x-symposium-feature-versions"], SYMPOSIUM_FEATURE_VERSIONS);
    assert.ok(openapi.paths["/.well-known/symposium.json"]);
    assert.ok(openapi.paths["/ahp"]);
});

test("bridge serves discovery documents before bearer authentication", async () => {
    const responses: Array<{ status: number; headers: Record<string, string>; body: string }> = [];
    const discovery = {
        manifest: () => ({ discoveryVersion: "1.0" }),
        openapi: () => ({ openapi: "3.1.0" }),
    };
    for (const path of ["/.well-known/symposium.json", "/openapi.json"]) {
        let status = 0;
        let headers: Record<string, string> = {};
        let body = "";
        const response = {
            writeHead: (statusCode: number, nextHeaders: Record<string, string>) => {
                status = statusCode;
                headers = nextHeaders;
            },
            end: (payload?: string) => {
                body = payload ?? "";
            },
        } as unknown as http.ServerResponse;
        await handleBridgeRequest(
            {
                method: "GET",
                url: path,
                headers: { host: "localhost" },
            } as http.IncomingMessage,
            response,
            "unused-token",
            {
                api: { version: "1.0.0" } as never,
                log: () => undefined,
                discovery,
                setLastRejection: () => undefined,
            },
        );
        responses.push({ status, headers, body });
    }
    assert.deepEqual(
        responses.map((item) => [item.status, item.headers["Cache-Control"]]),
        [
            [200, "no-cache"],
            [200, "no-cache"],
        ],
    );
    assert.deepEqual(JSON.parse(responses[0].body), { discoveryVersion: "1.0" });
    assert.deepEqual(JSON.parse(responses[1].body), { openapi: "3.1.0" });
});
