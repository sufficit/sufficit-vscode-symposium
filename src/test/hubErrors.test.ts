import assert from "node:assert/strict";
import test from "node:test";
import {
    HubRequestError,
    hubFailurePayload,
    hubStatusError,
    toHubRequestError,
} from "../sync/hubErrors";

test("401 and 403 are permission problems and are not retryable", () => {
    for (const status of [401, 403]) {
        const error = new HubRequestError(`rejected: HTTP ${status}`, { status });
        assert.equal(error.permissionProblem, true);
        assert.equal(error.retryable, false);
    }
});

test("server and transport failures are retryable, client errors are not", () => {
    assert.equal(new HubRequestError("boom", { status: 500 }).retryable, true);
    assert.equal(new HubRequestError("boom", { status: 429 }).retryable, true);
    assert.equal(new HubRequestError("boom").retryable, true); // transport-level (deadline/refused)
    assert.equal(new HubRequestError("boom", { status: 404 }).retryable, false);
    assert.equal(new HubRequestError("boom", { status: 400 }).permissionProblem, false);
});

test("toHubRequestError is a pass-through for already-classified errors", () => {
    const original = new HubRequestError("save rejected: HTTP 403", {
        status: 403,
        reasonCode: "scope_required",
        requiredPermission: "identity.mcp",
    });
    const normalized = toHubRequestError(original);
    assert.equal(normalized, original);
    assert.equal(normalized.reasonCode, "scope_required");
    assert.equal(normalized.requiredPermission, "identity.mcp");
    assert.equal(toHubRequestError(new Error("nope")).name, "HubRequestError");
});

test("permission payload tells the agent to reconnect instead of blaming the hub", () => {
    const payload = JSON.parse(
        hubFailurePayload(
            "save",
            new HubRequestError(
                "save rejected: HTTP 403 (reason scope_required, missing identity.mcp)",
                {
                    status: 403,
                    reasonCode: "scope_required",
                    requiredPermission: "identity.mcp",
                },
            ),
            { id: "abc" },
        ),
    ) as Record<string, unknown>;
    assert.match(String(payload.error), /HTTP 403/);
    assert.equal(payload.retryable, false);
    assert.equal(payload._memory_source, "auth_required");
    assert.match(String(payload._notice), /Reconnect the Sufficit account/);
    assert.match(String(payload._notice), /not evidence of a hub outage/);
    assert.equal(payload.id, "abc");
});

test("transport payload stays retryable and never claims an outage cause", () => {
    const payload = JSON.parse(
        hubFailurePayload("search", new HubRequestError("request timed out after 15000 ms")),
    ) as Record<string, unknown>;
    assert.equal(payload.retryable, true);
    assert.equal(payload._memory_source, "remote_unavailable");
    assert.match(String(payload._notice), /check whether it was saved before retrying/);
});

test("hubStatusError preserves a 403 scope_required response", () => {
    const error = hubStatusError(
        "save",
        { status: 403 } as Response,
        JSON.stringify({
            error: {
                reasonCode: "scope_required",
                requiredPermission: "identity.mcp",
            },
        }),
    );
    assert.equal(error.status, 403);
    assert.equal(error.reasonCode, "scope_required");
    assert.equal(error.requiredPermission, "identity.mcp");
    assert.equal(error.permissionProblem, true);
    assert.match(error.message, /missing identity\.mcp/);
});

test("hubStatusError handles text/invalid JSON without losing HTTP status", () => {
    const error = hubStatusError("search", { status: 503 } as Response, "temporarily unavailable");
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    assert.match(error.message, /HTTP 503/);
});
