import { test } from "node:test";
import assert from "node:assert/strict";
import { presentTurnError } from "../ui/errorPresentation";
import { isTransientErrorMessage } from "../adapters/transientError";

test("all-backends-exhausted 503 has a concise actionable system summary", () => {
    const raw =
        'HTTP 503 Service Unavailable {"error":{"message":"responses failed: All AI backends exhausted","code":"ai_backends_exhausted"}}';
    const out = presentTurnError(raw, true);

    assert.match(out.summary, /HTTP 503/);
    assert.match(out.summary, /all configured backends were unavailable/i);
    assert.match(out.summary, /automatic recovery was unavailable or exhausted/i);
    assert.equal(out.detail, raw);
});

test("403 identifies the required directive and explains the recovery", () => {
    const out = presentTurnError(
        'HTTP 403 Forbidden {"error":{"type":"permission_error","code":"insufficient_directive","required_directives":["AIUser"]}}',
        false,
    );

    assert.match(out.summary, /HTTP 403/);
    assert.match(out.summary, /account is signed in/i);
    assert.match(out.summary, /Required directive: AIUser/i);
    assert.match(out.summary, /administrator.*resend/i);
});

test("403 does not invent a directive when the provider omits it", () => {
    const out = presentTurnError("HTTP 403 Forbidden", false);

    assert.match(out.summary, /did not identify the required directive/i);
    assert.doesNotMatch(out.summary, /AIUser|AIControl/);
});

test("legacy AI control 403 names the AIControl directive", () => {
    const out = presentTurnError(
        "HTTP 403 Forbidden: direct provider routes require AI control access",
        false,
    );

    assert.match(out.summary, /Required directive: AIControl/i);
});

test("unknown terminal errors preserve their technical detail", () => {
    const out = presentTurnError("socket closed unexpectedly", true);

    assert.match(out.summary, /ended before the agent could reply/i);
    assert.equal(out.detail, "socket closed unexpectedly");
});

// A provider that is out of capacity is the clearest case for Retry: the same
// request may succeed moments later. It arrives mid-stream, after the gateway
// already sent 200 + SSE headers, so the HTTP status can no longer say 429/503
// and the wording is the only signal. It used to render "Retry is unavailable".
test("capacity and throttling failures are retryable", () => {
    for (const message of [
        "Selected model is at capacity. Please try a different model.",
        "The upstream provider is overloaded, try again later",
        "rate limit exceeded",
        "429 Too Many Requests",
        "Service Unavailable",
    ]) {
        assert.equal(isTransientErrorMessage(message), true, message);
    }
});

test("a genuine request problem is still not retryable", () => {
    for (const message of [
        "invalid api key",
        "model not found",
        "context length exceeded",
        "permission denied for this tool",
    ]) {
        assert.equal(isTransientErrorMessage(message), false, message);
    }
});
