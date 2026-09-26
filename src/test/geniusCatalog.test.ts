import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GeniusAdapter } from "../adapters/genius/adapter";
import { geniusMcpServers } from "../adapters/genius/mcpConfig";
import type { AgentEvent } from "../adapters/types";
import type { Server } from "../config/servers";

const fakeCli = path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs");

test("Genius receives managed external MCP servers without duplicating its built-ins", () => {
    const server = (name: string, manifest: Server["manifest"]): Server => ({
        name,
        manifest,
        tools: [],
        prompts: [],
        resources: [],
    });
    const result = geniusMcpServers([
        server("sufficit-ai", { name: "Sufficit AI", transport: "builtin", builtin: true }),
        server("docs", {
            name: "Docs",
            transport: "stdio",
            command: "docs-mcp",
            args: ["--read-only"],
            env: { DOCS_KEY: "test-secret" },
        }),
        server("research", {
            name: "Research",
            transport: "sse",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer test-secret" },
        }),
    ]);
    assert.deepEqual(result, [
        {
            name: "Docs",
            transport: "stdio",
            command: "docs-mcp",
            arguments: ["--read-only"],
            environment: { DOCS_KEY: "test-secret" },
        },
        {
            name: "Research",
            transport: "http",
            endpoint: "https://example.test/mcp",
            headers: { Authorization: "Bearer test-secret" },
        },
    ]);
});

test("Genius catalog populates the picker and context usage with delegated authentication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-catalog-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
        tokenProvider: () => Promise.resolve("delegated-test-token"),
    }));
    try {
        const catalog = await adapter.refreshModels();
        assert.deepEqual(catalog.models, ["default", "test-preset", "unknown-window"]);
        assert.equal(catalog.labels?.["test-preset"], "Test preset");

        const session = adapter.start({ cwd: root, model: "default" });
        const events: AgentEvent[] = [];
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Genius turn timed out")), 5000);
                session.on("event", (event: AgentEvent) => {
                    events.push(event);
                    if (event.kind !== "turn-end") return;
                    clearTimeout(timer);
                    resolve();
                });
                session.send("Hello");
            });
        } finally {
            session.dispose();
        }
        const usage = events.find((event) => event.kind === "usage");
        assert.equal(usage?.kind === "usage" ? usage.contextWindow : undefined, 128000);
        const calls = fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; authToken: string | null });
        assert.deepEqual(calls[0].args, ["models", "--json"]);
        assert.equal(calls[0].authToken, "delegated-test-token");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Genius receives Symposium MCP server definitions on the CLI child only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-mcp-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace, GENIUS_CLI_MCP_SERVERS_JSON: "stale" },
        tokenProvider: () => Promise.resolve("delegated-test-token"),
        mcpServers: () => [
            { name: "docs", transport: "stdio", command: "docs-mcp", arguments: [] },
        ],
    }));
    try {
        const session = adapter.start({ cwd: root, model: "default" });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Genius turn timed out")), 5000);
            session.on("event", (event: AgentEvent) => {
                if (event.kind !== "turn-end") return;
                clearTimeout(timer);
                resolve();
            });
            session.send("Search docs");
        });
        session.dispose();
        const call = JSON.parse(fs.readFileSync(trace, "utf8").trim()) as {
            mcpServers: string | null;
            authToken: string | null;
        };
        assert.deepEqual(JSON.parse(call.mcpServers ?? "null"), [
            {
                name: "docs",
                transport: "stdio",
                command: "docs-mcp",
                arguments: [],
                workingDirectory: root,
            },
        ]);
        assert.equal(call.authToken, "delegated-test-token");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
