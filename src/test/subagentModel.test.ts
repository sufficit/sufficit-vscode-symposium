import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentModel } from "../sessions/subagentModel";

const adapter = {
    modelLabels: () => ({ "preset-development-id": "Sufficit AI - Development (ollama)" }),
    models: () => ["preset-development-id"],
} as any;

test("subagent default model is omitted instead of sent as the literal default", async () => {
    assert.deepEqual(await resolveSubagentModel(adapter, "default", ""), { model: undefined });
});

test("subagent preset labels resolve to gateway model ids", async () => {
    assert.deepEqual(
        await resolveSubagentModel(adapter, "Sufficit AI - Development (ollama)", ""),
        { model: "preset-development-id" },
    );
});

test("subagent rejects an unavailable model instead of sending an invalid gateway value", async () => {
    const result = await resolveSubagentModel(adapter, "Missing preset", "");
    assert.match(result.error ?? "", /not available/);
});
