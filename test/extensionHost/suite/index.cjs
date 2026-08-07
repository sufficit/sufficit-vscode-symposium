const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vscode = require("vscode");

async function run() {
    const extension = vscode.extensions.getExtension("sufficit.sufficit-vscode-symposium");
    assert.ok(extension, "development extension is discoverable");
    await extension.activate();
    assert.equal(extension.isActive, true, "extension activates successfully");

    const manifest = JSON.parse(
        readFileSync(resolve(extension.extensionPath, "package.json"), "utf8"),
    );
    const expectedCommands = manifest.contributes.commands.map((entry) => entry.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = expectedCommands.filter((command) => !registered.has(command));
    assert.deepEqual(missing, [], `manifest commands missing after activation: ${missing.join(", ")}`);

    const config = vscode.workspace.getConfiguration("symposium");
    assert.equal(typeof config.get("chat.openIn"), "string");
    assert.equal(typeof config.get("codex.reasoning"), "string");

    const storageKey = "symposium.chat.sessionsSide";
    await extension.exports.settings.set(storageKey, "right", "workspace");
    assert.equal(await extension.exports.settings.get(storageKey), "right");
    await extension.exports.settings.delete(storageKey, "workspace");
}

module.exports = { run };
