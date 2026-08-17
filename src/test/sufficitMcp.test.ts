import { test } from "node:test";
import assert from "node:assert/strict";

import {
    SUFFICIT_IDENTITY_MCP_SERVER,
    SUFFICIT_IDENTITY_MCP_URL,
    SUFFICIT_MCP_ORIGIN_HEADER,
    SUFFICIT_MCP_SESSION_HEADER,
    buildAutomaticSufficitMcpServers,
    buildSufficitIdentityMcpServer,
    buildSufficitMcpServer,
    setSufficitIdentityMcpUrl,
    shouldRestartSufficitMcp,
} from "../adapters/sufficitMcp";

test("shared MCP contract fails closed without token or durable session", () => {
    assert.equal(buildSufficitMcpServer(null, "session-1", "vscode-claude"), undefined);
    assert.equal(buildSufficitMcpServer("token", undefined, "vscode-copilot"), undefined);
    assert.equal(buildSufficitMcpServer("token", "new-1", "vscode-codex"), undefined);
});

test("Identity MCP reuses login automatically without requiring a conversation id", () => {
    assert.equal(buildSufficitIdentityMcpServer(null), undefined);
    const server = buildSufficitIdentityMcpServer("secret");
    assert.ok(server);
    assert.equal(server.url, SUFFICIT_IDENTITY_MCP_URL);
    assert.deepEqual(server.headers, { Authorization: "Bearer secret" });

    const beforeSession = buildAutomaticSufficitMcpServers("secret", undefined, "vscode-claude");
    assert.deepEqual(Object.keys(beforeSession), [SUFFICIT_IDENTITY_MCP_SERVER]);
    const withSession = buildAutomaticSufficitMcpServers(
        "secret",
        "native-session",
        "vscode-claude",
    );
    assert.deepEqual(Object.keys(withSession).sort(), ["sufficit_ai", "sufficit_identity"]);
});

test("authenticated MCP restart detects token and Identity endpoint changes", () => {
    setSufficitIdentityMcpUrl("https://tenant.example/api/mcp");
    assert.equal(
        shouldRestartSufficitMcp(
            "token",
            undefined,
            "vscode-claude",
            undefined,
            undefined,
            undefined,
            "token",
            "https://tenant.example/api/mcp",
        ),
        false,
    );
    setSufficitIdentityMcpUrl("https://other.example/api/mcp");
    assert.equal(
        shouldRestartSufficitMcp(
            "token",
            undefined,
            "vscode-claude",
            undefined,
            undefined,
            undefined,
            "token",
            "https://tenant.example/api/mcp",
        ),
        true,
    );
    setSufficitIdentityMcpUrl(undefined);
});

test("all CLI adapters receive the same session-scoped HTTP MCP contract", () => {
    const server = buildSufficitMcpServer(
        "secret",
        "native-session",
        "vscode-claude",
        "user-approved",
    );
    assert.ok(server);
    assert.equal(server.type, "http");
    assert.equal(server.url, "https://ai.sufficit.com.br/mcp");
    const headers = server.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret");
    assert.equal(headers[SUFFICIT_MCP_SESSION_HEADER], "native-session");
    assert.equal(headers[SUFFICIT_MCP_ORIGIN_HEADER], "user-approved");
    assert.equal(headers["X-MEMORY-SOURCE-ID"], "vscode-claude");

    const planServer = buildSufficitMcpServer(
        "secret",
        "native-session",
        "vscode-codex",
        "agent-requested",
        "plan",
    );
    assert.equal(
        (planServer?.headers as Record<string, string>)["X-SYMPOSIUM-PERMISSION-MODE"],
        "plan",
    );
});
