import assert from "node:assert/strict";
import test from "node:test";
import * as vscode from "vscode";
import type { SessionInfo } from "../adapters/types";
import { registerSessionCommands } from "../extension/commands/sessions";
import { startGeniusSessionRefresh } from "../extension/geniusSessionRefresh";
import { ChatPanel } from "../ui/chatPanel";

const info: SessionInfo = {
    backend: "genius",
    sessionId: "11111111-2222-4333-8444-555555555555",
    title: "Old title",
};

test("Genius rename command sends the title to the native owner", async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const original = vscode.commands.registerCommand;
    const originalInput = vscode.window.showInputBox;
    let title = "";
    vscode.commands.registerCommand = ((name: string, handler: (...args: unknown[]) => unknown) => {
        registered.set(name, handler);
        return { dispose() {} };
    }) as typeof vscode.commands.registerCommand;
    vscode.window.showInputBox = (() =>
        Promise.resolve("Shared title")) as typeof vscode.window.showInputBox;
    try {
        registerSessionCommands({
            context: { subscriptions: [] },
            infoOf: (item: SessionInfo) => item,
            geniusTitleSync: {
                rename: (_session: SessionInfo, value: string) => {
                    title = value;
                    return Promise.resolve();
                },
            },
        } as never);
        await registered.get("symposium.renameSession")?.(info);
        assert.equal(title, "Shared title");
    } finally {
        vscode.commands.registerCommand = original;
        vscode.window.showInputBox = originalInput;
    }
});

test("native title refresh updates the open Symposium surfaces", async () => {
    const previousRefresh = ChatPanel.refreshSessions;
    const previousMeta = ChatPanel.reMetaActive;
    let listRefreshes = 0;
    let metadataRefreshes = 0;
    let localTitle: string | undefined;
    ChatPanel.refreshSessions = () => {
        listRefreshes++;
    };
    ChatPanel.reMetaActive = () => {
        metadataRefreshes++;
    };
    const context = { subscriptions: [] as { dispose(): void }[] };
    const result = startGeniusSessionRefresh(
        context as never,
        {
            listSessions: () => Promise.resolve([info]),
            renameSession: () => Promise.resolve(),
        } as never,
        {
            customTitle: () => localTitle,
            setTitle: (_session: SessionInfo, value: string | undefined) => {
                localTitle = value;
                return Promise.resolve();
            },
        } as never,
        {
            listCached: () => [info],
            reconcile: () => Promise.resolve([info]),
        } as never,
        {
            refreshSessions: () => {
                listRefreshes++;
                return Promise.resolve();
            },
            reMetaActive: () => {
                metadataRefreshes++;
            },
        } as never,
        () => undefined,
    );
    try {
        await result.geniusTitleSync.rename(info, "Shared title");
        assert.equal(listRefreshes, 2);
        assert.equal(metadataRefreshes, 2);
    } finally {
        result.geniusTitleSync.dispose();
        ChatPanel.refreshSessions = previousRefresh;
        ChatPanel.reMetaActive = previousMeta;
    }
});
