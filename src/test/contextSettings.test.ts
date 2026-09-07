import { test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { openaiConfig } from "../extension/config";
import { contextPolicyPreference } from "../ui/configContextPolicy";

test("active adapter context settings read the latest saved configuration", (t) => {
    let history = 17;
    let summaryTargetTokens = 900;
    t.mock.method(vscode.workspace, "getConfiguration", () => ({
        get: (key: string, fallback: unknown) =>
            key === "maxHistoryMessages"
                ? history
                : key === "contextPolicy"
                  ? { summaryTargetTokens }
                  : fallback,
    }));
    const config = openaiConfig({
        extension: { packageJSON: { version: "test" } },
    } as unknown as vscode.ExtensionContext);
    assert.equal(config.maxHistoryMessages, 17);
    history = 63;
    summaryTargetTokens = 777;
    assert.equal(config.maxHistoryMessages, 63);
    assert.equal(config.contextPolicy?.summaryTargetTokens, 777);
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
