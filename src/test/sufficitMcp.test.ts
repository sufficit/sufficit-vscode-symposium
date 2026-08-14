import { test } from "node:test";
import assert from "node:assert/strict";

import {
    SUFFICIT_MCP_ORIGIN_HEADER,
    SUFFICIT_MCP_SESSION_HEADER,
    buildSufficitMcpServer,
} from "../adapters/sufficitMcp";

test("shared MCP contract fails closed without token or durable session", () => {
    assert.equal(buildSufficitMcpServer(null, "session-1", "vscode-claude"), undefined);
    assert.equal(buildSufficitMcpServer("token", undefined, "vscode-copilot"), undefined);
    assert.equal(buildSufficitMcpServer("token", "new-1", "vscode-codex"), undefined);
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
