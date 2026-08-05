import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { parseCodexModelCatalog } from "../adapters/codex/models";
import { buildHttpMcpWrapperScript, codexWorkspaceArgs, mcpHttpWrapperPath } from "../adapters/codex/codexMcpConfig";
import { CodexSession, codexModelArgs, codexPromptArgs } from "../adapters/codex/session";
import { looksInjected } from "../adapters/codex/transcript";
import { buildReasoningMenuOptions } from "../ui/reasoningOptions";

test("HTTP MCP wrapper reads URL and headers from mcp.json at runtime", () => {
    const script = buildHttpMcpWrapperScript("/tmp/mcp.json", "sufficit'quoted");

    assert.ok(script.includes(`const CONFIG_PATH = ${JSON.stringify("/tmp/mcp.json")};`));
    assert.ok(script.includes(`const SERVER_NAME = ${JSON.stringify("sufficit'quoted")};`));
    assert.ok(script.includes("fs.readFileSync(CONFIG_PATH"));
    assert.ok(script.includes("server.headers"));
    assert.equal(script.includes("const URL ="), false);
    assert.equal(script.includes("const HEADERS ="), false);
});

test("HTTP MCP wrapper path encodes server names as a single file name", () => {
    const wrapperPath = mcpHttpWrapperPath("../secrets/sufficit");

    assert.equal(path.dirname(wrapperPath), path.join(os.homedir(), ".symposium"));
    assert.equal(path.basename(wrapperPath), "mcp-http-..%2Fsecrets%2Fsufficit.js");
});

test("Codex workspace args add writable VS Code workspace roots", () => {
    const cwd = path.resolve("/workspace/main");
    const extra = path.resolve("/mnt/sufficit");

    assert.deepEqual(
        codexWorkspaceArgs(cwd, [cwd, extra, extra, "relative"]),
        ["--cd", cwd, "--add-dir", extra],
    );
});

test("Codex model catalog uses CLI metadata without model-name hardcoding", () => {
    const result = parseCodexModelCatalog({
        models: [
            { slug: "hidden-model", display_name: "Hidden", visibility: "hide", priority: 1 },
            { slug: "zeta-agent", display_name: "Zeta Agent", visibility: "list", priority: 20 },
            { slug: "alpha-agent", display_name: "Alpha Agent", visibility: "list", priority: 10 },
        ],
    }, "configured-model");

    assert.deepEqual(result.models, ["configured-model", "alpha-agent", "zeta-agent"]);
    assert.deepEqual(result.labels, {
        "alpha-agent": "Alpha Agent",
        "zeta-agent": "Zeta Agent",
    });
});

test("Codex applies a model picker change to the next exec turn", () => {
    assert.deepEqual(codexModelArgs("gpt-5.6", "gpt-5.5-codex"), ["--model", "gpt-5.6"]);
    assert.deepEqual(codexModelArgs("default", "gpt-5.5-codex"), ["--model", "gpt-5.5-codex"]);
    assert.deepEqual(codexModelArgs(undefined, ""), []);
});

test("Codex exposes the latest effective model for session restoration", () => {
    const session = new CodexSession({ executable: "codex", model: "gpt-5.6-sol", reasoning: "default", approvalPolicy: "admin", sandboxMode: "danger-full-access" }, { cwd: process.cwd(), model: "gpt-5.6-sol" });
    (session as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna" } }));
    assert.equal(session.getModel(), "gpt-5.6-luna");
    session.dispose();
});

test("reasoning picker places the effective default without duplicating its level", () => {
    assert.deepEqual(
        buildReasoningMenuOptions(["medium", "default", "high", "xhigh", "low", "minimal", "medium"], "medium"),
        [
            { value: "minimal", label: "minimal" },
            { value: "low", label: "low" },
            { value: "default", label: "medium (default)" },
            { value: "high", label: "high" },
            { value: "xhigh", label: "xhigh" },
        ],
    );
});

test("Codex reads fresh and resumed prompts from stdin instead of argv", () => {
    assert.deepEqual(codexPromptArgs(undefined), ["-"]);
    assert.deepEqual(codexPromptArgs("session-123"), ["resume", "session-123", "-"]);

    const oversizedHandoff = "x".repeat(2_000_000);
    assert.ok(!codexPromptArgs(undefined).includes(oversizedHandoff));
});

test("Codex transcript ignores injected operational messages as session titles", () => {
    assert.equal(looksInjected("[Terminal execution] When a shell tool is available..."), true);
    assert.equal(looksInjected("[PLAN — current step marked below]"), true);
    assert.equal(looksInjected("[RTK command policy] Use rtk when available."), true);
    assert.equal(looksInjected("Corrija a duplicação das sessões de subagentes."), false);
});
