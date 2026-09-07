import { test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { openaiConfig, buildCustomAdapters } from "../extension/config";
import { contextPolicyPreference } from "../ui/configContextPolicy";
import type { OpenAIAdapterConfig } from "../adapters/openai/types";
import { runLocalTool } from "../adapters/aiTools/localRun";
import type { ToolContext } from "../adapters/aiTools/types";
import * as sessionReader from "../sessionReader";

test("active adapter context settings read the latest saved configuration", (t) => {
    let history = 17;
    let summaryTargetTokens = 900;
    let autoCompactAt = 0;
    let autoCompactOnTasksComplete = false;
    t.mock.method(vscode.workspace, "getConfiguration", () => ({
        get: (key: string, fallback: unknown) =>
            key === "maxHistoryMessages"
                ? history
                : key === "contextPolicy"
                  ? { summaryTargetTokens }
                  : key === "autoCompactAt"
                    ? autoCompactAt
                    : key === "autoCompactOnTasksComplete"
                      ? autoCompactOnTasksComplete
                      : fallback,
    }));
    const config = openaiConfig({
        extension: { packageJSON: { version: "test" } },
    } as unknown as vscode.ExtensionContext);
    assert.equal(config.maxHistoryMessages, 17);
    assert.equal(config.autoCompactAt, 0);
    assert.equal(config.autoCompactOnTasksComplete, false);
    const [adapter] = buildCustomAdapters(
        {
            extension: { packageJSON: { version: "test" } },
        } as unknown as vscode.ExtensionContext,
        [{ id: "custom", baseUrl: "https://example.test" }],
    );
    const customConfig = (
        adapter as unknown as { getConfig: () => OpenAIAdapterConfig }
    ).getConfig();
    history = 63;
    summaryTargetTokens = 777;
    autoCompactAt = 0.8;
    autoCompactOnTasksComplete = true;
    assert.equal(config.maxHistoryMessages, 63);
    assert.equal(config.contextPolicy?.summaryTargetTokens, 777);
    for (const current of [config, customConfig]) {
        assert.equal(current.autoCompactAt, 0.8);
        assert.equal(current.autoCompactOnTasksComplete, true);
        assert.equal(current.maxHistoryMessages, 63);
        assert.equal(current.contextPolicy?.summaryTargetTokens, 777);
    }
});

test("read_session consumes saved page size and supports an explicit continuation size", async (t) => {
    t.mock.method(vscode.workspace, "getConfiguration", () => ({
        get: () => ({ readMaxCharacters: 19 }),
    }));
    const dump: sessionReader.SessionDump = {
        id: "saved-original",
        source: "ledger",
        count: 1,
        messages: [{ role: "tool", text: "long-result-".repeat(30) }],
    };
    t.mock.method(sessionReader, "readSession", (id: string) => {
        assert.equal(id, dump.id);
        return dump;
    });
    const ctx = { sessionId: dump.id } as ToolContext;
    const first = await runLocalTool("read_session", { char_offset: 0 }, ctx);
    assert.match(first!, /next_char_offset=19/);
    assert.equal(first!.split("\n\n").slice(1).join("\n\n").length, 19);
    const next = await runLocalTool(
        "read_session",
        { id: dump.id, char_offset: 19, max_chars: 11, tail: 1 },
        ctx,
    );
    assert.match(next!, /next_char_offset=30/);
    assert.equal(next!.split("\n\n").slice(1).join("\n\n").length, 11);
    assert.equal(dump.messages[0].text, "long-result-".repeat(30));
});

test("changing one policy control retains other saved fields and rejects invalid input", (t) => {
    t.mock.method(vscode.workspace, "getConfiguration", () => ({
        get: () => ({ summaryTargetTokens: 765, historyNotice: false }),
    }));
    const updated = contextPolicyPreference(
        "symposium.openai.contextPolicy.readMaxCharacters",
        "1234",
    );
    assert.equal(updated?.value.readMaxCharacters, 1234);
    assert.equal(updated?.value.summaryTargetTokens, 765);
    assert.equal(updated?.value.historyNotice, false);
    assert.throws(() =>
        contextPolicyPreference("symposium.openai.contextPolicy.readMaxCharacters", "-2"),
    );
});
