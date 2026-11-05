import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as vscode from "vscode";
import { registerMiscCommands } from "../extension/commands/misc";

/**
 * The phase-9 bundle cleanup turned openConfig, seedExamples and
 * showRemoteAccess into lazy loaders that import their panel modules only
 * when the command runs. This exercises each handler with the webview API
 * disabled: the dynamic import lines stay covered and the seed command still
 * writes its example resources into the configured root.
 */
test("misc commands import config, seed and remote-access panels on demand", async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const originalRegister = vscode.commands.registerCommand;
    const originalProvider = vscode.window.registerWebviewViewProvider;
    const originalCreate = vscode.window.createWebviewPanel;
    const originalInfo = vscode.window.showInformationMessage;
    const originalConfig = vscode.workspace.getConfiguration;
    const messages: string[] = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-misc-"));

    vscode.commands.registerCommand = ((
        name: string,
        handler: (...args: unknown[]) => unknown,
    ) => {
        registered.set(name, handler);
        return { dispose() {} };
    }) as typeof vscode.commands.registerCommand;
    vscode.window.registerWebviewViewProvider = (() => ({
        dispose() {},
    })) as typeof vscode.window.registerWebviewViewProvider;
    vscode.window.createWebviewPanel = (() => {
        throw new Error("webview unavailable in tests");
    }) as typeof vscode.window.createWebviewPanel;
    vscode.window.showInformationMessage = ((message: string) => {
        messages.push(message);
        return Promise.resolve(undefined);
    }) as typeof vscode.window.showInformationMessage;
    vscode.workspace.getConfiguration = ((section: string) => ({
        get: (key: string, fallback: unknown) => {
            if (section === "symposium" && key === "root") {
                return root;
            }
            if (section === "symposium.bridge" && (key === "enabled" || key === "pwa")) {
                return true;
            }
            return fallback;
        },
    })) as unknown as typeof vscode.workspace.getConfiguration;

    try {
        registerMiscCommands({
            context: { subscriptions: [] },
            chatView: {},
            api: {},
            auth: {},
            bridge: {
                stop() {},
                start: () => Promise.resolve(undefined),
                getConnection: () => undefined,
            },
            refreshAll() {},
            output: { show() {} },
            sessionIndex: { memoryUsageBytes: () => 0, listCached: () => [] },
        } as never);

        const openConfig = registered.get("symposium.openConfig");
        assert.ok(openConfig, "symposium.openConfig must be registered");
        await assert.rejects(openConfig() as Promise<unknown>, /webview unavailable in tests/);

        const seedExamples = registered.get("symposium.seedExamples");
        assert.ok(seedExamples, "symposium.seedExamples must be registered");
        await assert.rejects(seedExamples() as Promise<unknown>, /webview unavailable in tests/);
        assert.ok(fs.existsSync(path.join(root, "repo", "agents", "code-reviewer.md")));
        assert.equal(messages.length, 1);

        const showRemoteAccess = registered.get("symposium.showRemoteAccess");
        assert.ok(showRemoteAccess, "symposium.showRemoteAccess must be registered");
        await assert.rejects(
            showRemoteAccess() as Promise<unknown>,
            /webview unavailable in tests/,
        );
    } finally {
        vscode.commands.registerCommand = originalRegister;
        vscode.window.registerWebviewViewProvider = originalProvider;
        vscode.window.createWebviewPanel = originalCreate;
        vscode.window.showInformationMessage = originalInfo;
        vscode.workspace.getConfiguration = originalConfig;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
