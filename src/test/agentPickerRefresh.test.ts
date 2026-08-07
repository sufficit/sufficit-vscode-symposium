import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("availability probes refresh an active agent picker without reopening it", () => {
    const create = readFileSync(
        resolve(__dirname, "../../src/extension/commands/create.ts"),
        "utf8",
    );
    const surface = readFileSync(resolve(__dirname, "../../src/ui/chatSurface.ts"), "utf8");
    const dispatch = readFileSync(resolve(__dirname, "../../src/ui/webview/dispatch.ts"), "utf8");
    const picker = readFileSync(resolve(__dirname, "../../src/ui/webview/agentPicker.ts"), "utf8");

    assert.match(
        create,
        /collectAgentPickerEntries\(\)\s*\.then\(\(agents\) => panel\.refreshAgentPicker\(agents\)\)/,
    );
    assert.match(
        create,
        /collectAgentPickerEntries\(\)\s*\.then\(\(agents\) => chatView\.refreshAgentPicker\(agents\)\)/,
    );
    assert.doesNotMatch(
        create,
        /collectAgentPickerEntries\(\)\s*\.then\(\(agents\) => panel\.showAgentPicker\(agents\)\)/,
    );
    assert.match(surface, /type: "agent-picker-update", agents/);
    assert.match(dispatch, /case "agent-picker-update"/);
    assert.match(picker, /if \(!root\.classList\.contains\("picking"\)\) \{\s*return;\s*\}/);
});
