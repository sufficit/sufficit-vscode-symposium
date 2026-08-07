import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
    SUFFICIT_MCP_SERVER,
    SUFFICIT_MCP_URL,
    SUFFICIT_MCP_TOKEN_ENV,
    SUFFICIT_MCP_CONTEXT_ID,
    SUFFICIT_MCP_SOURCE_ID,
    buildSufficitMcpSection,
    hasSufficitMcpSection,
    upsertSufficitMcpSection,
    syncSufficitMcpConfig,
    setCodexSufficitTokenProvider,
    resolveCodexSufficitToken,
    applyCodexSufficitToken,
    syncCodexSufficitMcp,
} from "../adapters/codex/sufficitMcp";

const createTempDir = (): string => {
    return fs.mkdtempSync(path.join(tmpdir(), "symposium-codex-mcp-test-"));
};

test("constants match expected values", () => {
    assert.equal(SUFFICIT_MCP_SERVER, "sufficit_ai");
    assert.equal(SUFFICIT_MCP_URL, "https://ai.sufficit.com.br/mcp");
    assert.equal(SUFFICIT_MCP_TOKEN_ENV, "SYMPOSIUM_SUFFICIT_MCP_TOKEN");
});

test("buildSufficitMcpSection returns TOML with enabled/disabled and URL/env", () => {
    const enabled = buildSufficitMcpSection(true).split("\n");
    assert.ok(enabled.some((l: string) => l.includes("[mcp_servers.sufficit_ai]")));
    assert.ok(enabled.some((l: string) => l.trim() === "enabled = true"));
    assert.ok(enabled.some((l: string) => l.includes(`url = ${JSON.stringify(SUFFICIT_MCP_URL)}`)));
    assert.ok(
        enabled.some((l: string) =>
            l.includes(`bearer_token_env_var = ${JSON.stringify(SUFFICIT_MCP_TOKEN_ENV)}`),
        ),
    );
    assert.ok(enabled.includes(`[mcp_servers.${SUFFICIT_MCP_SERVER}.http_headers]`));
    assert.ok(enabled.some((l: string) => l.includes(SUFFICIT_MCP_CONTEXT_ID)));
    assert.ok(enabled.some((l: string) => l.includes(SUFFICIT_MCP_SOURCE_ID)));

    const disabled = buildSufficitMcpSection(false).split("\n");
    assert.ok(disabled.some((l: string) => l.trim() === "enabled = false"));
});

test("hasSufficitMcpSection detects section header", () => {
    const present = `[mcp_servers.${SUFFICIT_MCP_SERVER}]`;
    assert.ok(hasSufficitMcpSection(present));
    assert.ok(hasSufficitMcpSection(`\n\n${present}\n`));
    assert.ok(!hasSufficitMcpSection(""));
    assert.ok(!hasSufficitMcpSection("[other]\n"));
});

test("upsertSufficitMcpSection inserts new section when absent", () => {
    const content = "root = true";
    const result = upsertSufficitMcpSection(content, true);
    const lines = result.split("\n");
    assert.ok(lines.includes("root = true"));
    assert.ok(hasSufficitMcpSection(result));
    assert.ok(result.includes("enabled = true"));
});

test("upsertSufficitMcpSection replaces existing section", () => {
    const content = `
root = true

[mcp_servers.sufficit_ai]
enabled = false
url = "http://old"
bearer_token_env_var = "OLD"
[mcp_servers.sufficit_ai.http_headers]
X-MEMORY-CONTEXT-ID = "old-context"

[other]
foo = bar
`;
    const result = upsertSufficitMcpSection(content, true);
    const lines = result.split("\n");
    assert.ok(hasSufficitMcpSection(result));
    assert.ok(result.includes(SUFFICIT_MCP_URL));
    assert.ok(!result.includes("http://old"));
    assert.ok(!result.includes("OLD"));
    assert.ok(!result.includes("old-context"));
    assert.equal(result.split("[mcp_servers.sufficit_ai.http_headers]").length - 1, 1);
    assert.ok(result.includes("enabled = true"));
    assert.ok(lines.some((l: string) => l.includes("[other]")));
    assert.ok(lines.some((l: string) => l.includes("foo = bar")));
});

test("upsertSufficitMcpSection disables and removes token when token is absent", () => {
    const content = `
[mcp_servers.sufficit_ai]
enabled = true
url = "${SUFFICIT_MCP_URL}"
bearer_token_env_var = "${SUFFICIT_MCP_TOKEN_ENV}"
`;
    const result = upsertSufficitMcpSection(content, false);
    assert.ok(hasSufficitMcpSection(result));
    assert.ok(result.includes("enabled = false"));
    assert.ok(result.includes(SUFFICIT_MCP_URL));
});

test("syncSufficitMcpConfig writes/upserts to ~/.codex/config.toml and reports change", () => {
    const tmp = createTempDir();
    const homeDir = tmp;
    const configPath = path.join(homeDir, ".codex", "config.toml");

    const token = "test-token-abc";
    const r1 = syncSufficitMcpConfig(token, homeDir);
    assert.equal(r1.configPath, configPath);
    assert.equal(r1.enabled, true);
    assert.ok(r1.changed);
    assert.ok(fs.existsSync(configPath));
    const content1 = fs.readFileSync(configPath, "utf8");
    assert.ok(hasSufficitMcpSection(content1));
    assert.ok(content1.includes("enabled = true"));
    assert.ok(content1.includes(SUFFICIT_MCP_URL));
    assert.ok(content1.includes(SUFFICIT_MCP_TOKEN_ENV));

    const r2 = syncSufficitMcpConfig(token, homeDir);
    assert.equal(r2.changed, false);

    const r3 = syncSufficitMcpConfig(null, homeDir);
    assert.equal(r3.enabled, false);
    assert.ok(r3.changed);
    const content2 = fs.readFileSync(configPath, "utf8");
    assert.ok(content2.includes("enabled = false"));

    fs.rmSync(tmp, { recursive: true, force: true });
});

test("setCodexSufficitTokenProvider and resolveCodexSufficitToken plumb token provider", async () => {
    setCodexSufficitTokenProvider(() => Promise.resolve("provider-token"));
    assert.equal(await resolveCodexSufficitToken(), "provider-token");

    setCodexSufficitTokenProvider(() => Promise.resolve(null));
    assert.equal(await resolveCodexSufficitToken(), null);

    setCodexSufficitTokenProvider(undefined);
    assert.equal(await resolveCodexSufficitToken(), null);
});

test("resolveCodexSufficitToken swallows errors and returns null", async () => {
    setCodexSufficitTokenProvider(() => Promise.reject(new Error("boom")));
    assert.equal(await resolveCodexSufficitToken(), null);
    setCodexSufficitTokenProvider(undefined);
});

test("applyCodexSufficitToken sets process.env and deletes when null", () => {
    const original = process.env[SUFFICIT_MCP_TOKEN_ENV];
    delete process.env[SUFFICIT_MCP_TOKEN_ENV];

    applyCodexSufficitToken("abc");
    assert.equal(process.env[SUFFICIT_MCP_TOKEN_ENV], "abc");

    applyCodexSufficitToken(null);
    assert.ok(!(SUFFICIT_MCP_TOKEN_ENV in process.env));

    if (original !== undefined) {
        process.env[SUFFICIT_MCP_TOKEN_ENV] = original;
    }
});

test("syncCodexSufficitMcp resolves token, applies to env and writes config", async () => {
    const tmp = createTempDir();
    const homeDir = tmp;

    setCodexSufficitTokenProvider(() => Promise.resolve("sync-token"));
    const result = await syncCodexSufficitMcp(false, homeDir);
    assert.equal(result.enabled, true);
    assert.ok(result.changed);
    assert.equal(process.env[SUFFICIT_MCP_TOKEN_ENV], "sync-token");

    const configPath = path.join(homeDir, ".codex", "config.toml");
    assert.ok(fs.existsSync(configPath));
    const content = fs.readFileSync(configPath, "utf8");
    assert.ok(hasSufficitMcpSection(content));
    assert.ok(content.includes("enabled = true"));

    delete process.env[SUFFICIT_MCP_TOKEN_ENV];
    fs.rmSync(tmp, { recursive: true, force: true });
    setCodexSufficitTokenProvider(undefined);
});
