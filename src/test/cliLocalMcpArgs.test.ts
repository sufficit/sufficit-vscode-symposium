import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeSession } from "../adapters/claude/session";
import { CodexSession } from "../adapters/codex/session";
import { CopilotSession } from "../adapters/copilot/session";
import { LOCAL_MCP_READ_SESSION_TOOL, setLocalMcpEndpoint } from "../adapters/localMcp/endpoint";
import type { AgentEvent, AgentSession } from "../adapters/types";

const TOKEN = "arg-test-secret-token";

/** Fake CLI that records its argv and exits, so no real backend is involved. */
function writeRecorder(dir: string): { exe: string; out: string } {
    const exe = path.join(dir, "recorder.cjs");
    const out = path.join(dir, "argv.json");
    fs.writeFileSync(
        exe,
        [
            "#!/usr/bin/env node",
            "const fs = require('fs');",
            `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`,
            "process.stdin.on('error', () => {});",
            "process.stdin.resume();",
            "setTimeout(() => process.exit(0), 80);",
        ].join("\n"),
        { mode: 0o755 },
    );
    return { exe, out };
}

function turnEnd(session: AgentSession): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("turn-end timeout")), 8000);
        session.on("event", (event: AgentEvent) => {
            if (event.kind === "turn-end") {
                clearTimeout(timer);
                resolve();
            }
        });
    });
}

async function withTemporaryHome(
    body: (dir: string, home: string) => Promise<void>,
): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-cliargs-"));
    const home = path.join(dir, "home");
    fs.mkdirSync(home);
    const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    setLocalMcpEndpoint({ url: "http://127.0.0.1:9/mcp", token: TOKEN });
    try {
        await body(dir, home);
    } finally {
        setLocalMcpEndpoint(undefined);
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("Claude spawn passes the local MCP config and pre-approves only read_session", async () => {
    await withTemporaryHome(async (dir, home) => {
        const { exe, out } = writeRecorder(dir);
        const session = new ClaudeSession(
            { executable: exe, model: "", permissionMode: "acceptEdits", env: {} },
            { cwd: dir, guardrailSessionId: "conversation-claude" },
        );
        try {
            const ended = turnEnd(session);
            session.send("hello", undefined, undefined, "i1");
            await ended;
        } finally {
            session.dispose();
        }
        const argv: string[] = JSON.parse(fs.readFileSync(out, "utf8"));
        const config = path.join(home, ".symposium", "claude-mcp.json");
        assert.equal(argv[argv.indexOf("--mcp-config") + 1], config);
        assert.ok(argv.includes(`--allowedTools=${LOCAL_MCP_READ_SESSION_TOOL}`));
        const written = fs.readFileSync(config, "utf8");
        const server = JSON.parse(written).mcpServers.symposium;
        assert.equal(server.headers["X-SYMPOSIUM-SESSION-ID"], "conversation-claude");
        assert.equal(written.includes(TOKEN), false);
    });
});

test("Copilot spawn loads the local MCP server with --additional-mcp-config", async () => {
    await withTemporaryHome(async (dir, home) => {
        const { exe, out } = writeRecorder(dir);
        const session = new CopilotSession(
            { executable: exe, model: "" },
            { cwd: dir, guardrailSessionId: "conversation-copilot" },
        );
        try {
            const ended = turnEnd(session);
            session.send("hello");
            await ended;
        } finally {
            session.dispose();
        }
        const argv: string[] = JSON.parse(fs.readFileSync(out, "utf8"));
        // Copilot CLI rejects --mcp-config; the supported flag takes "@<file>".
        assert.equal(argv.includes("--mcp-config"), false);
        const config = path.join(home, ".symposium", "copilot-mcp.json");
        assert.equal(argv[argv.indexOf("--additional-mcp-config") + 1], `@${config}`);
        const written = fs.readFileSync(config, "utf8");
        const server = JSON.parse(written).mcpServers.symposium;
        assert.equal(server.headers["X-SYMPOSIUM-SESSION-ID"], "conversation-copilot");
        assert.equal(written.includes(TOKEN), false);
    });
});

test("Codex spawn registers the local MCP server through -c overrides only", async () => {
    await withTemporaryHome(async (dir, home) => {
        const { exe, out } = writeRecorder(dir);
        const session = new CodexSession(
            {
                executable: exe,
                model: "",
                reasoning: "default",
                approvalPolicy: "never",
                sandboxMode: "read-only",
            },
            { cwd: dir, guardrailSessionId: "conversation-codex" },
        );
        try {
            const ended = turnEnd(session);
            session.send("hello");
            await ended;
        } finally {
            session.dispose();
        }
        const argv: string[] = JSON.parse(fs.readFileSync(out, "utf8"));
        assert.ok(argv.includes('mcp_servers.symposium.url="http://127.0.0.1:9/mcp"'));
        assert.ok(
            argv.includes(
                'mcp_servers.symposium.http_headers={ "X-SYMPOSIUM-SESSION-ID" = "conversation-codex" }',
            ),
        );
        assert.equal(argv.join(" ").includes(TOKEN), false);
        // Nothing is persisted in the user's Codex configuration.
        assert.equal(fs.existsSync(path.join(home, ".codex")), false);
    });
});
