import assert from "node:assert/strict";
import test from "node:test";
import { preserveSelectedModel } from "../ui/webview/modelCatalog";

test("late model discovery preserves a restored session model", () => {
    assert.deepEqual(preserveSelectedModel(["gpt-5.6-sol", "gpt-5.6-terra"], "gpt-5.6-luna"), [
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
    ]);
    assert.deepEqual(preserveSelectedModel(["gpt-5.6-sol"], "gpt-5.6-sol"), ["gpt-5.6-sol"]);
    assert.deepEqual(preserveSelectedModel(["gpt-5.6-sol"], "default"), ["gpt-5.6-sol"]);
});
