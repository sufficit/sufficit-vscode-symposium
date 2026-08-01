import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizePresetId,
    parseSufficitPresetUsage,
    SufficitPresetUsage,
    sufficitPresetUsageUrl,
} from "../adapters/openai/presetUsage";
import type { OpenAIAdapterConfig } from "../adapters/openai/types";

const compactPresetId = "1234567890abcdef1234567890abcdef";
const dashedPresetId = "12345678-90ab-cdef-1234-567890abcdef";

const officialElevenLabsUsage = {
    presetId: dashedPresetId,
    presetTitle: "Voice chat",
    healthPercent: 99,
    providers: [
        {
            providerId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            providerKey: "elevenlabs",
            providerTitle: "ElevenLabs",
            providerType: "elevenlabs",
            enabled: true,
            healthy: true,
            healthPercent: 99,
            usageSupported: true,
            usage: {
                source: "elevenlabs_subscription",
                currency: "credits",
                usedAmount: 3820,
                limitAmount: 420988,
                remainingAmount: 417168,
                remainingPercent: 99.092609,
                periodEndUtc: "2026-08-13T17:51:17.000Z",
                isAvailable: true,
                planName: "Creator",
                balanceLine: "417168 credits remaining",
                hasRateLimits: true,
                rateLimits: [
                    {
                        key: "credits",
                        label: "Credits",
                        usedPercent: 0.907391,
                        remainingPercent: 99.092609,
                        resetsAt: "2026-08-13T17:51:17.000Z",
                    },
                ],
            },
        },
    ],
};

function config(): OpenAIAdapterConfig {
    return {
        api: "responses",
        baseUrl: "https://ai.sufficit.com.br/openai/v1",
        model: "",
        models: [],
        headers: {},
        apiKey: "test-token",
    };
}

test("preset usage URL uses a query string and canonical Guid", () => {
    assert.equal(normalizePresetId(compactPresetId), dashedPresetId);
    assert.equal(
        sufficitPresetUsageUrl("https://ai.sufficit.com.br/openai/v1/", dashedPresetId),
        `https://ai.sufficit.com.br/api/ai/presets/usage-summary?presetId=${dashedPresetId}`,
    );
    assert.equal(sufficitPresetUsageUrl("https://api.openai.com/v1", dashedPresetId), undefined);
});

test("preset usage exposes only aggregate preset health", () => {
    const snapshot = parseSufficitPresetUsage(officialElevenLabsUsage, "openai", "Sufficit AI");
    assert.ok(snapshot);
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.displayName, "Sufficit AI · Voice chat");
    assert.equal(snapshot.healthPercent, 99);
    assert.equal(snapshot.plan, undefined);
    assert.equal(snapshot.limitName, undefined);
    assert.deepEqual(snapshot.windows, []);
});

test("provider details never expand the preset snapshot", () => {
    const response = structuredClone(officialElevenLabsUsage);
    response.providers.push({
        ...structuredClone(response.providers[0]),
        providerId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        providerKey: "backup",
        providerTitle: "Backup provider",
    });
    const snapshot = parseSufficitPresetUsage(response, "openai", "Sufficit AI");
    assert.ok(snapshot);
    assert.equal(snapshot.healthPercent, 99);
    assert.deepEqual(snapshot.windows, []);
});

test("a response without aggregate health is unavailable", () => {
    const response = structuredClone(officialElevenLabsUsage);
    delete (response as { healthPercent?: number }).healthPercent;
    const snapshot = parseSufficitPresetUsage(response, "openai", "Sufficit AI");
    assert.ok(snapshot);
    assert.equal(snapshot.state, "unavailable");
    assert.equal(snapshot.healthPercent, undefined);
    assert.deepEqual(snapshot.windows, []);
    assert.match(snapshot.message ?? "", /aggregate health/i);
});

test("selected preset id is sent with auth and a failed refresh keeps only that preset stale", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestHeaders: RequestInit["headers"];
    let fail = false;
    globalThis.fetch = (input, init) => {
        requestUrl = String(input);
        requestHeaders = init?.headers;
        return Promise.resolve(
            fail
                ? new Response("unavailable", { status: 503 })
                : new Response(JSON.stringify(officialElevenLabsUsage), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                  }),
        );
    };
    try {
        const usage = new SufficitPresetUsage("openai", "Sufficit AI", config);
        const ready = await usage.read(true, { model: compactPresetId });
        assert.equal(ready.state, "ready");
        assert.equal(
            requestUrl,
            `https://ai.sufficit.com.br/api/ai/presets/usage-summary?presetId=${dashedPresetId}`,
        );
        assert.equal(new Headers(requestHeaders).get("authorization"), "Bearer test-token");

        fail = true;
        const stale = await usage.read(true, { model: compactPresetId });
        assert.equal(stale.state, "stale");
        assert.equal(stale.healthPercent, 99);
        assert.deepEqual(stale.windows, []);
        assert.match(stale.message ?? "", /HTTP 503.*cached/i);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
