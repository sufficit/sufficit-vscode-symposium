import * as vscode from "vscode";
import { SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatSurface, ChatSurfaceDeps } from "./chatSurface";

interface PendingOpen {
    kind: "session" | "dialogue" | "follow";
    info?: SessionInfo;
    backend?: string;
    options?: SessionStartOptions;
    title?: string;
}

/**
 * Sidebar surface (WebviewView) in the Symposium container. Same webview
 * as the editor panel: when the view is wide the sessions list shows
 * beside the chat; narrow hides it behind the toggle. Drag the Symposium
 * container to the secondary side bar for right-side placement.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = "symposium.chat";

    private view: vscode.WebviewView | undefined;
    private surface: ChatSurface | undefined;
    private pending: PendingOpen | undefined;

    constructor(private readonly deps: ChatSurfaceDeps) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        this.surface = new ChatSurface(webviewView.webview, this.deps,
            (title) => { if (this.view) { this.view.title = title; } });
        webviewView.onDidDispose(() => {
            this.surface?.dispose();
            this.surface = undefined;
            this.view = undefined;
        });
        this.consumePending();
    }

    async openSession(info: SessionInfo): Promise<void> {
        this.pending = { kind: "session", info };
        await this.reveal();
    }

    async followSession(info: SessionInfo): Promise<void> {
        this.pending = { kind: "follow", info };
        await this.reveal();
    }

    async openDialogue(backend: string, options: SessionStartOptions, title: string): Promise<void> {
        this.pending = { kind: "dialogue", backend, options, title };
        await this.reveal();
    }

    private async reveal(): Promise<void> {
        await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
        this.consumePending();
    }

    private consumePending(): void {
        if (!this.pending || !this.surface) {
            return;
        }
        const pending = this.pending;
        this.pending = undefined;
        if (pending.kind === "session" && pending.info) {
            this.surface.openSession(pending.info);
        } else if (pending.kind === "follow" && pending.info) {
            void this.surface.followSession(pending.info);
        } else if (pending.kind === "dialogue" && pending.backend && pending.options) {
            this.surface.openDialogue(pending.backend, pending.options, pending.title ?? "New dialogue");
        }
    }
}
