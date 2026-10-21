import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
    LOCAL_MCP_READ_SESSION_TOOL,
    LOCAL_MCP_TOKEN_ENV,
    buildLocalMcpCodexArgs,
    buildLocalMcpServer,
    currentLocalMcpUrl,
    isLocalMcpName,
    setLocalMcpEndpoint,
} from "../adapters/localMcp/endpoint";
import { LocalMcpServer, LOCAL_MCP_SESSION_HEADER } from "../adapters/localMcp/server";
import type { LocalMcpTool } from "../adapters/localMcp/server";
import { symposiumLocalTools } from "../adapters/localMcp/tools";
import { buildClaudeMcpConfig, claudeMcpCliArgs } from "../adapters/claude/mcpConfig";

interface Reply {
    status: number;
    body: string;
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            url,
            { method: "POST", headers: { "Content-Type": "application/json", ...headers } },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );
        req.on("error", reject);
        req.end(body);
    });
}

function rpc(id: number, method: string, params?: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const echo: LocalMcpTool = {
    name: "read_session",
    description: "echo",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: (args, ctx) => `session=${ctx.sessionId ?? "none"} id=${String(args.id ?? "")}`,
};

async function withServer(
    tools: LocalMcpTool[],
    body: (url: string, auth: Record<string, string>) => Promise<void>,
): Promise<void> {
    const server = new LocalMcpServer(tools);
    const endpoint = await server.start();
    try {
        await body(endpoint.url, { Authorization: `Bearer ${endpoint.token}` });
    } finally {
        await server.dispose();
    }
}

test("local MCP server refuses callers without the per-process token", async () => {
    await withServer([echo], async (url, auth) => {
        assert.equal((await post(url, rpc(1, "ping"))).status, 401);
        assert.equal(
            (await post(url, rpc(1, "ping"), { Authorization: "Bearer nope" })).status,
            401,
        );
        assert.equal((await post(url, rpc(1, "ping"), auth)).status, 200);
    });
});

test("local MCP server only answers loopback authority without a browser Origin", async () => {
    await withServer([echo], async (url, auth) => {
        const forgedHost = await post(url, rpc(1, "ping"), { ...auth, Host: "evil.example" });
        assert.equal(forgedHost.status, 403);
        const browser = await post(url, rpc(1, "ping"), { ...auth, Origin: "http://evil.example" });
        assert.equal(browser.status, 403);
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    });
});

test("local MCP server speaks initialize, tools/list and tools/call with the session header", async () => {
    await withServer([echo], async (url, auth) => {
        const init = JSON.parse(
            (await post(url, rpc(1, "initialize", { protocolVersion: "2025-06-18" }), auth)).body,
        );
        assert.equal(init.result.protocolVersion, "2025-06-18");
        assert.equal(init.result.serverInfo.name, "symposium");

        const unknown = JSON.parse(
            (await post(url, rpc(2, "initialize", { protocolVersion: "1999-01-01" }), auth)).body,
        );
        assert.equal(unknown.result.protocolVersion, "2025-06-18");

        const note = await post(
            url,
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            auth,
        );
        assert.equal(note.status, 202);

        const list = JSON.parse((await post(url, rpc(3, "tools/list"), auth)).body);
        assert.deepEqual(
            list.result.tools.map((tool: { name: string }) => tool.name),
            ["read_session"],
        );
        assert.equal(list.result.tools[0].annotations.readOnlyHint, true);

        const call = JSON.parse(
            (
                await post(url, rpc(4, "tools/call", { name: "read_session", arguments: {} }), {
                    ...auth,
                    [LOCAL_MCP_SESSION_HEADER]: "conversation-7",
                })
            ).body,
        );
        assert.equal(call.result.content[0].text, "session=conversation-7 id=");
        const noHeader = JSON.parse(
            (
                await post(
                    url,
                    rpc(5, "tools/call", { name: "read_session", arguments: { id: "other" } }),
                    auth,
                )
            ).body,
        );
        assert.equal(noHeader.result.content[0].text, "session=none id=other");
    });
});

test("local MCP server reports protocol and tool failures without crashing", async () => {
    const failing: LocalMcpTool = {
        ...echo,
        name: "boom",
        run: () => {
            throw new Error("exploded");
        },
    };
    await withServer([failing], async (url, auth) => {
        const method = JSON.parse((await post(url, rpc(1, "nope/nope"), auth)).body);
        assert.equal(method.error.code, -32601);
        const missing = JSON.parse(
            (await post(url, rpc(2, "tools/call", { name: "absent" }), auth)).body,
        );
        assert.equal(missing.error.code, -32602);
        const boom = JSON.parse(
            (await post(url, rpc(3, "tools/call", { name: "boom" }), auth)).body,
        );
        assert.equal(boom.result.isError, true);
        assert.equal(boom.result.content[0].text, "exploded");
        const bad = await post(url, "{not json", auth);
        assert.equal(bad.status, 400);
        assert.equal(JSON.parse(bad.body).error.code, -32700);
        const batch = JSON.parse(
            (await post(url, `[${rpc(7, "ping")},${rpc(8, "ping")}]`, auth)).body,
        );
        assert.deepEqual(
            batch.map((reply: { id: number }) => reply.id),
            [7, 8],
        );
        assert.equal((await post(url, "[]", auth)).status, 202);
        assert.equal(
            await new Promise<number>((resolve, reject) => {
                http.get(url, { headers: auth }, (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                }).on("error", reject);
            }),
            405,
        );
    });
});

test("local MCP server rejects oversized bodies and stays available", async () => {
    await withServer([echo], async (url, auth) => {
        const big = await post(url, "a".repeat(1024 * 1024 + 10), auth).catch(() => ({
            status: 413,
            body: "",
        }));
        assert.equal(big.status, 413);
        assert.equal((await post(url, rpc(1, "ping"), auth)).status, 200);
    });
});

test("disposing the local MCP server closes the port and forgets the token", async () => {
    const server = new LocalMcpServer([echo]);
    const endpoint = await server.start();
    await assert.rejects(server.start(), /already started/);
    await server.dispose();
    await assert.rejects(
        post(endpoint.url, rpc(1, "ping"), { Authorization: `Bearer ${endpoint.token}` }),
    );
    await server.dispose();
});

test("endpoint config references the token by environment variable and never embeds it", () => {
    setLocalMcpEndpoint(undefined);
    assert.equal(buildLocalMcpServer("s1"), undefined);
    assert.deepEqual(buildLocalMcpCodexArgs("s1"), []);
    assert.equal(process.env[LOCAL_MCP_TOKEN_ENV], undefined);

    setLocalMcpEndpoint({ url: "http://127.0.0.1:9/mcp", token: "secret-token-value" });
    try {
        assert.equal(currentLocalMcpUrl(), "http://127.0.0.1:9/mcp");
        assert.equal(process.env[LOCAL_MCP_TOKEN_ENV], "secret-token-value");
        const server = buildLocalMcpServer(" conversation-1 ");
        assert.deepEqual(server?.headers, {
            Authorization: `Bearer \${${LOCAL_MCP_TOKEN_ENV}}`,
            [LOCAL_MCP_SESSION_HEADER]: "conversation-1",
        });
        assert.equal(server?.url, "http://127.0.0.1:9/mcp");
        const withoutSession = buildLocalMcpServer(undefined);
        assert.deepEqual(withoutSession?.headers, {
            Authorization: `Bearer \${${LOCAL_MCP_TOKEN_ENV}}`,
        });

        const codex = buildLocalMcpCodexArgs("conversation-1");
        assert.deepEqual(
            codex.filter((value) => value === "-c"),
            ["-c", "-c", "-c"],
        );
        assert.ok(codex.includes('mcp_servers.symposium.url="http://127.0.0.1:9/mcp"'));
        assert.ok(
            codex.includes(`mcp_servers.symposium.bearer_token_env_var="${LOCAL_MCP_TOKEN_ENV}"`),
        );
        assert.ok(
            codex.includes(
                'mcp_servers.symposium.http_headers={ "X-SYMPOSIUM-SESSION-ID" = "conversation-1" }',
            ),
        );
        assert.equal(JSON.stringify([server, codex]).includes("secret-token-value"), false);
        assert.deepEqual(claudeMcpCliArgs("/tmp/x.json"), [
            "--mcp-config",
            "/tmp/x.json",
            `--allowedTools=${LOCAL_MCP_READ_SESSION_TOOL}`,
        ]);
    } finally {
        setLocalMcpEndpoint(undefined);
    }
    assert.equal(process.env[LOCAL_MCP_TOKEN_ENV], undefined);
    assert.deepEqual(claudeMcpCliArgs("/tmp/x.json"), ["--mcp-config", "/tmp/x.json"]);
    assert.deepEqual(claudeMcpCliArgs(undefined), []);
});

test("a user-defined server named symposium cannot shadow the local read_session server", () => {
    assert.equal(isLocalMcpName(" Symposium "), true);
    assert.equal(isLocalMcpName("symposium-other"), false);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-localmcp-"));
    const originalHome = process.env.HOME;
    const originalProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    setLocalMcpEndpoint({ url: "http://127.0.0.1:9/mcp", token: "secret-token-value" });
    try {
        const result = buildClaudeMcpConfig(
            { mcpServers: { Symposium: { command: "evil" }, other: { command: "ok" } } },
            "conversation-1",
            undefined,
            undefined,
        );
        assert.ok(result.path);
        const written = fs.readFileSync(result.path, "utf8");
        const servers = JSON.parse(written).mcpServers;
        assert.equal(servers.Symposium, undefined);
        assert.equal(servers.symposium.url, "http://127.0.0.1:9/mcp");
        assert.equal(servers.other.command, "ok");
        assert.equal(written.includes("secret-token-value"), false);
    } finally {
        setLocalMcpEndpoint(undefined);
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = originalProfile;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("local MCP tools reuse the in-process read_session contract", () => {
    const tools = symposiumLocalTools();
    assert.deepEqual(
        tools.map((tool) => tool.name),
        ["read_session"],
    );
    const [tool] = tools;
    assert.equal(tool.inputSchema.type, "object");
    assert.match(tool.description, /Symposium chat session/);
    const noSession = tool.run({}, {});
    assert.match(String(noSession), /no session id/);
});
