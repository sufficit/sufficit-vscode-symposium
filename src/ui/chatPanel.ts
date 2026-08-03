import * as vscode from "vscode";
import { SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatSurface, ChatSurfaceDeps } from "./chatSurface";
import { AgentPickerEntry } from "./protocol";

/**
 * Editor surface: one reusable full-size panel with the sessions list
 * beside the chat (master-detail inside the webview), mirroring how the
 * built-in chat opens sessions as an editor.
 */
export class ChatPanel {
    private static readonly panels = new Set<ChatPanel>();
    private static newChatPanel: ChatPanel | undefined;
    private readonly surface: ChatSurface;
    private readonly panel: vscode.WebviewPanel;
    private sessionId: string | undefined;

    /**
     * Opens a reusable blank-chat panel. Once it receives a session, that
     * panel becomes dedicated to it, so the next New Chat creates another
     * editor tab just like Claude Code / the built-in VS Code Chat.
     */
    static show(context: vscode.ExtensionContext, deps: ChatSurfaceDeps): ChatPanel {
        if (ChatPanel.newChatPanel) {
            ChatPanel.newChatPanel.panel.reveal();
            return ChatPanel.newChatPanel;
        }
        const panel = new ChatPanel(context, deps);
        ChatPanel.newChatPanel = panel;
        return panel;
    }

    /** Opens a new blank editor tab and shows its agent picker. */
    static newSession(context: vscode.ExtensionContext, deps: ChatSurfaceDeps, agents: AgentPickerEntry[]): ChatPanel {
        const panel = new ChatPanel(context, deps);
        panel.showAgentPicker(agents);
        return panel;
    }

    /** Opens one dedicated editor tab per existing conversation. */
    static openSession(context: vscode.ExtensionContext, deps: ChatSurfaceDeps, info: SessionInfo): ChatPanel {
        const existing = [...ChatPanel.panels].find((panel) => panel.sessionId === info.sessionId);
        if (existing) {
            existing.panel.reveal();
            return existing;
        }
        const panel = new ChatPanel(context, deps);
        panel.openSession(info);
        return panel;
    }

    /**
     * Opens (or reveals) a dedicated editor tab that read-only *follows* a
     * session running elsewhere. Same find-or-reveal dedup as openSession, but
     * a freshly created panel binds STRAIGHT into follow mode. Going through
     * openSession() first would run a full normal session-open (real history
     * fetch + a ChatController registered in LiveSessions) only to tear it down
     * on the immediately-following followSession() — a wasted open that also
     * leaks a stray controller. The followed process has no local controller.
     */
    static followSession(context: vscode.ExtensionContext, deps: ChatSurfaceDeps, info: SessionInfo): ChatPanel {
        const existing = [...ChatPanel.panels].find((panel) => panel.sessionId === info.sessionId);
        if (existing) {
            existing.panel.reveal();
            void existing.followSession(info);
            return existing;
        }
        const panel = new ChatPanel(context, deps);
        void panel.followSession(info);
        return panel;
    }

    /** Re-pushes the sessions list to every open panel. */
    static refreshSessions(): void {
        for (const panel of ChatPanel.panels) { void panel.surface.refreshSessions(); }
    }

    /** Re-pushes the active session title to each open panel's chat header. */
    static reMetaActive(): void {
        for (const panel of ChatPanel.panels) { void panel.surface.reMetaActive(); }
    }


    /** Resets only panels currently showing the just-deleted session. */
    static sessionDeleted(sessionId: string): void {
        for (const panel of ChatPanel.panels) {
            if (panel.sessionId === sessionId) { panel.surface.sessionDeleted(sessionId); }
        }
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
            (sessionId) => { this.sessionId = sessionId; },
            () => this.panel.reveal(this.panel.viewColumn, true),
            /* chatOnly */ true);
        ChatPanel.panels.add(this);
        this.panel.onDidDispose(() => {
            this.surface.dispose();
            ChatPanel.panels.delete(this);
            if (ChatPanel.newChatPanel === this) { ChatPanel.newChatPanel = undefined; }
        }, undefined, context.subscriptions);
    }

    openSession(info: SessionInfo): void {
        this.sessionId = info.sessionId;
        if (ChatPanel.newChatPanel === this) { ChatPanel.newChatPanel = undefined; }
        this.surface.openSession(info);
    }

    async followSession(info: SessionInfo): Promise<void> {
        this.sessionId = info.sessionId;
        if (ChatPanel.newChatPanel === this) { ChatPanel.newChatPanel = undefined; }
        await this.surface.followSession(info);
    }

    openDialogue(backend: string, options: SessionStartOptions, title: string): void {
        // Reserve a blank panel before the backend creates its session so a
        // second New Chat never replaces an in-flight conversation.
        this.sessionId = options.resumeSessionId;
        if (ChatPanel.newChatPanel === this) { ChatPanel.newChatPanel = undefined; }
        this.surface.openDialogue(backend, options, title);
    }

    showAgentPicker(agents: import("./protocol").AgentPickerEntry[]): void {
        this.surface.showAgentPicker(agents);
    }

    refreshAgentPicker(agents: import("./protocol").AgentPickerEntry[]): void {
        this.surface.refreshAgentPicker(agents);
    }

    openTerminalDialogue(backend: string, options: SessionStartOptions & { env?: Record<string, string>; tmuxName?: string; reasoning?: string }, title: string): void {
        this.sessionId = options.resumeSessionId;
        if (ChatPanel.newChatPanel === this) { ChatPanel.newChatPanel = undefined; }
        this.surface.openTerminalDialogue(backend, options, title);
    }
}
