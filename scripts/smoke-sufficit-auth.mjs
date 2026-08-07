#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";

// Public checks run with `npm run smoke:auth-ai`. To include authenticated
// Sufficit AI checks, provide SUFFICIT_SMOKE_TOKEN; add SUFFICIT_SMOKE_MODEL to
// make one minimal generation request. The script never prints credentials or
// user claims. Device-flow validation creates one short-lived, unapproved code.

const identityBase = normalizedBase(
    process.env.SUFFICIT_IDENTITY_URL || "https://identity.sufficit.com.br",
);
const aiBase = normalizedBase(
    process.env.SUFFICIT_AI_URL || "https://ai.sufficit.com.br",
);
const clientId = process.env.SUFFICIT_SYMPOSIUM_CLIENT_ID || "sufficit-vscode-symposium";
const redirectUri = process.env.SUFFICIT_SYMPOSIUM_REDIRECT_URI
    || "vscode://sufficit.sufficit-vscode-symposium/callback";
const requestedScopes = (
    process.env.SUFFICIT_SYMPOSIUM_SCOPE
    || "openid profile email roles directives offline_access"
).split(/\s+/).filter(Boolean);
const accessToken = process.env.SUFFICIT_SMOKE_TOKEN?.trim();
const generationModel = process.env.SUFFICIT_SMOKE_MODEL?.trim();
const timeoutMs = positiveInteger(process.env.SUFFICIT_SMOKE_TIMEOUT_MS, 15_000);

function normalizedBase(value) {
    return value.trim().replace(/\/+$/, "");
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function check(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function request(url, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function readJson(response, label) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${label} returned non-JSON content (HTTP ${response.status})`);
    }
}

function assertEndpoint(discovery, key) {
    const value = discovery[key];
    check(typeof value === "string" && value.startsWith(`${identityBase}/`),
        `Identity discovery has an invalid ${key}`);
    return value;
}

function extractResponseText(payload) {
    if (typeof payload?.output_text === "string") {
        return payload.output_text;
    }
    if (Array.isArray(payload?.output)) {
        return payload.output.flatMap((item) => item?.content || [])
            .map((part) => part?.text || part?.output_text || "")
            .join("");
    }
    return payload?.choices?.map((choice) => choice?.message?.content || "").join("") || "";
}

async function validateIdentityDiscovery() {
    const response = await request(`${identityBase}/.well-known/openid-configuration`);
    check(response.ok, `Identity discovery failed with HTTP ${response.status}`);
    const discovery = await readJson(response, "Identity discovery");
    const supportedScopes = new Set(discovery.scopes_supported || []);
    for (const scope of requestedScopes) {
        check(supportedScopes.has(scope), `Identity does not advertise the '${scope}' scope`);
    }
    assertEndpoint(discovery, "authorization_endpoint");
    assertEndpoint(discovery, "token_endpoint");
    assertEndpoint(discovery, "userinfo_endpoint");
    assertEndpoint(discovery, "device_authorization_endpoint");
    console.log("PASS identity discovery and required scopes");
    return discovery;
}

async function validateDeviceClient(discovery) {
    const body = new URLSearchParams({
        client_id: clientId,
        scope: requestedScopes.join(" "),
    });
    const response = await request(discovery.device_authorization_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
    });
    const payload = await readJson(response, "Device authorization");
    check(response.ok,
        `Device authorization rejected '${clientId}' with ${payload.error || response.status}`);
    for (const key of ["device_code", "user_code", "verification_uri"]) {
        check(typeof payload[key] === "string" && payload[key],
            `Device authorization response is missing '${key}'`);
    }
    console.log("PASS Symposium device-flow client registration");
}

async function validatePkceClient(discovery) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: requestedScopes.join(" "),
        code_challenge_method: "S256",
        code_challenge: challenge,
        state: randomBytes(16).toString("base64url"),
        prompt: "none",
    }).toString();
    const response = await request(url, { redirect: "manual" });
    const location = response.headers.get("location") || "";
    check(response.status >= 300 && response.status < 400,
        `PKCE authorization returned HTTP ${response.status}`);
    check(location.startsWith(redirectUri),
        `Identity rejected the Symposium redirect URI '${redirectUri}'`);
    console.log("PASS Symposium PKCE redirect registration");
}

async function validateAuthenticatedAI() {
    if (!accessToken) {
        console.log("SKIP authenticated AI checks (set SUFFICIT_SMOKE_TOKEN)");
        return;
    }
    const headers = {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
    };
    const sessionResponse = await request(`${aiBase}/api/auth/session`, { headers });
    const session = await readJson(sessionResponse, "AI auth session");
    check(sessionResponse.ok, `AI auth session failed with HTTP ${sessionResponse.status}`);
    check(session.isAuthenticated === true, "AI rejected the supplied Identity token");
    check(Array.isArray(session.policies) && session.policies.includes("aiuser"),
        "Authenticated Identity token does not grant the AI user policy");
    console.log("PASS Identity token accepted by Sufficit AI");

    const modelsResponse = await request(`${aiBase}/openai/v1/models`, { headers });
    const models = await readJson(modelsResponse, "AI model catalog");
    check(modelsResponse.ok, `AI model catalog failed with HTTP ${modelsResponse.status}`);
    check(Array.isArray(models.data) && models.data.length > 0,
        "AI model catalog returned no models");
    console.log(`PASS Sufficit AI model response (${models.data.length} models)`);

    if (!generationModel) {
        console.log("SKIP generation check (set SUFFICIT_SMOKE_MODEL)");
        return;
    }
    const marker = "symposium-smoke-ok";
    const generationResponse = await request(`${aiBase}/openai/v1/responses`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
            model: generationModel,
            input: `Reply with exactly: ${marker}`,
            max_output_tokens: 32,
            stream: false,
        }),
    });
    const generation = await readJson(generationResponse, "AI generation");
    check(generationResponse.ok, `AI generation failed with HTTP ${generationResponse.status}`);
    check(extractResponseText(generation).toLowerCase().includes(marker),
        "AI generation response did not contain the expected marker");
    console.log(`PASS Sufficit AI generation response (${generationModel})`);
}

try {
    const discovery = await validateIdentityDiscovery();
    await validateDeviceClient(discovery);
    await validatePkceClient(discovery);
    await validateAuthenticatedAI();
} catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
