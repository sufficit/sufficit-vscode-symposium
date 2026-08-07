import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codexUsage } from "../adapters/codex/usage";
import { claudeUsage } from "../adapters/claude/usage";
import { copilotUsage } from "../adapters/copilot/usage";

const readSource = (relative: string) =>
    readFileSync(resolve(__dirname, "../../src", relative), "utf8");

test("each CLI adapter exposes only its own module singleton", () => {
    assert.equal(codexUsage.backend, "codex");
    assert.equal(claudeUsage.backend, "claude");
    assert.equal(copilotUsage.backend, "copilot");
    assert.notStrictEqual(codexUsage, claudeUsage);
    assert.notStrictEqual(claudeUsage, copilotUsage);

    assert.match(readSource("adapters/codex/adapter.ts"), /readonly usage = codexUsage/);
    assert.match(readSource("adapters/claude/adapter.ts"), /readonly usage = claudeUsage/);
    assert.match(readSource("adapters/copilot/adapter.ts"), /readonly usage = copilotUsage/);
});

test("OpenAI-compatible adapters own an isolated usage service per instance", () => {
    const source = readSource("adapters/openai/adapter.ts");
    assert.match(source, /readonly usage: AdapterUsageProvider/);
    assert.match(source, /this\.backend === "openai"/);
    assert.match(
        source,
        /new SufficitPresetUsage\(this\.backend, this\.displayName, this\.getConfig\)/,
    );
    assert.match(source, /new EmptyAdapterUsage\(this\.backend, this\.displayName\)/);
});

test("all adapter usage services share one normalized response interface", async () => {
    const source = readSource("adapters/quotaTypes.ts");
    assert.match(source, /interface AdapterUsageProvider/);
    assert.match(
        source,
        /read\(force\?: boolean, context\?: \{ model\?: string \}\): Promise<AdapterQuotaSnapshot>/,
    );

    const copilot = await copilotUsage.read();
    assert.equal(copilot.state, "unavailable");
    assert.deepEqual(copilot.windows, []);
});
