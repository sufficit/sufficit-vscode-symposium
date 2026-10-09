import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = (file: string): string =>
    readFileSync(resolve(__dirname, "../../src", file), "utf8");

test("VS Code Speech restores the originating Symposium composer after starting", () => {
    const bridge = source("voice/vscodeSpeechBridge.ts");
    const startCommand = bridge.indexOf("executeCommand(START_DICTATION_COMMAND)");
    const restoreFocus = bridge.indexOf("await session.restoreFocus();", startCommand);
    const returnStarted = bridge.indexOf("return true;", restoreFocus);

    assert.ok(startCommand >= 0, "bridge must start native editor dictation");
    assert.ok(
        restoreFocus > startCommand,
        "composer must be restored after the command captures its editor model",
    );
    assert.ok(
        returnStarted > restoreFocus,
        "focus restoration must finish before recording is reported as active",
    );
});

test("each chat surface supplies an exact reveal callback to speech dictation", () => {
    const panel = source("ui/chatPanel.ts");
    const view = source("ui/chatView.ts");
    const voice = source("ui/surfaceMessageVoice.ts");

    assert.match(panel, /\(\) => this\.panel\.reveal\(this\.panel\.viewColumn, true\)/);
    assert.match(view, /executeCommand\(`\$\{ChatViewProvider\.viewId\}\.focus`\)/);
    assert.match(
        voice,
        /startVscodeSpeechDictation\(\s*settings\.language,\s*d\.restoreFocus,?\s*\)/,
    );
});

test("bridge disables the built-in dictation backend around the start command", () => {
    const bridge = source("voice/vscodeSpeechBridge.ts");

    assert.ok(
        bridge.includes("function disableBuiltinEditorDictation"),
        "bridge must toggle dictation.enabled for the start command",
    );
    const disable = bridge.indexOf(
        "const restoreDictationEnabled = await disableBuiltinEditorDictation();",
    );
    const settle = bridge.indexOf("DICTATION_TOGGLE_SETTLE_MS);", disable);
    const startCommand = bridge.indexOf("executeCommand(START_DICTATION_COMMAND)", disable);
    const restore = bridge.indexOf("await restoreDictationEnabled();", startCommand);

    assert.ok(disable >= 0, "start path must disable the built-in backend first");
    assert.ok(
        settle > disable && settle < startCommand,
        "must wait for context keys to settle between disabling and starting",
    );
    assert.ok(
        startCommand > disable,
        "start command must run while the built-in backend is disabled",
    );
    assert.ok(
        restore > startCommand,
        "original dictation.enabled values must be restored after starting",
    );
    assert.match(
        bridge,
        /ConfigurationTarget\.Global,\s*inspect\?\.globalValue/,
        "explicit global value must round-trip back to global",
    );
    assert.match(
        bridge,
        /ConfigurationTarget\.Workspace,\s*inspect\?\.workspaceValue/,
        "explicit workspace value must round-trip back to workspace",
    );
});

test("bridge activates the speech provider before starting dictation", () => {
    const bridge = source("voice/vscodeSpeechBridge.ts");

    assert.ok(
        bridge.includes("async function ensureProviderExtensionActive"),
        "bridge must activate ms-vscode.vscode-speech before the start command",
    );
    const activate = bridge.indexOf("await ensureProviderExtensionActive();");
    const disable = bridge.indexOf(
        "const restoreDictationEnabled = await disableBuiltinEditorDictation();",
    );
    const startCommand = bridge.indexOf("executeCommand(START_DICTATION_COMMAND)", disable);

    assert.ok(
        activate >= 0 && activate < disable && disable < startCommand,
        "provider must be active before disabling the built-in backend and starting",
    );
});

test("bridge closes the dictation editor tab when releasing a session", () => {
    const bridge = source("voice/vscodeSpeechBridge.ts");

    assert.ok(
        bridge.includes("function closeDictationTab"),
        "release must close the dictation document tab",
    );
    const release = bridge.indexOf("async function releaseSession");
    const closeCall = bridge.indexOf("closeDictationTab(session.document)", release);
    const unlink = bridge.indexOf("fs.unlink(session.filePath)", release);

    assert.ok(closeCall > release, "releaseSession must close the tab");
    assert.ok(unlink > closeCall, "tab must close before the backing file is deleted");
    assert.match(bridge, /tabGroups\.close\(tabs\)/, "close must go through the tabGroups API");
});
