import * as vscode from "vscode";
import { SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatSurface, ChatSurfaceDeps } from "./chatSurface";

/**
 * Editor surface: one reusable full-size panel with the sessions list
 * beside the chat (master-detail inside the webview), mirroring how the
 * built-in chat opens sessions as an editor.
 */
export class ChatPanel {
    private static current: ChatPanel | undefined;
    private readonly surface: ChatSurface;
    private readonly panel: vscode.WebviewPanel;

    static show(context: vscode.ExtensionContext, deps: ChatSurfaceDeps): ChatPanel {
        if (ChatPanel.current) {
            ChatPanel.current.panel.reveal();
            return ChatPanel.current;
        }
        ChatPanel.current = new ChatPanel(context, deps);
        return ChatPanel.current;
    }

    /** Re-pushes the sessions list to the open panel, if any. */
    static refreshSessions(): void {
        void ChatPanel.current?.surface.refreshSessions();
    }

    private constructor(context: vscode.ExtensionContext, deps: ChatSurfaceDeps) {
        this.panel = vscode.window.createWebviewPanel(
            "symposium.chat",
            "Symposium",
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.surface = new ChatSurface(this.panel.webview, deps,
            (title) => { this.panel.title = title; },
            /* chatOnly */ true);
        this.panel.onDidDispose(() => {
            this.surface.dispose();
            ChatPanel.current = undefined;
        }, undefined, context.subscriptions);
    }

    openSession(info: SessionInfo): void {
        this.surface.openSession(info);
    }

    async followSession(info: SessionInfo): Promise<void> {
        await this.surface.followSession(info);
    }

    openDialogue(backend: string, options: SessionStartOptions, title: string): void {
        this.surface.openDialogue(backend, options, title);
    }

    openTerminalDialogue(backend: string, options: SessionStartOptions & { env?: Record<string, string>; tmuxName?: string }, title: string): void {
        this.surface.openTerminalDialogue(backend, options, title);
    }
}
