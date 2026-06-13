import * as vscode from "vscode";
import { AgentAdapter, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { renderHtml } from "./chatHtml";
import { symposiumLog } from "../extension";

export interface ChatSurfaceDeps {
    adapterByBackend: Map<string, AgentAdapter>;
    listSessions(): Promise<SessionInfo[]>;
    cwdFor(info: SessionInfo): string;
}

/**
 * Wires one webview (sidebar view or editor panel) to the chat machinery:
 * ready handshake with queued posts (postMessage before the webview script
 * is live is silently dropped), the in-webview sessions list, and dialogue
 * switching without rebuilding the HTML.
 */
export class ChatSurface {
    private controller: ChatController | undefined;
    private ready = false;
    private queue: unknown[] = [];

    constructor(
        private readonly webview: vscode.Webview,
        private readonly deps: ChatSurfaceDeps,
        private readonly onTitleChange?: (title: string) => void,
    ) {
        webview.options = { enableScripts: true };
        webview.html = renderHtml();
        webview.onDidReceiveMessage((message) => void this.onMessage(message));
    }

    private post(message: unknown): void {
        symposiumLog(`[surface] -> webview: ${(message as any)?.type}${this.ready ? "" : " (queued)"}`);
        if (this.ready) {
            void this.webview.postMessage(message);
        } else {
            this.queue.push(message);
        }
    }

    private async onMessage(message: any): Promise<void> {
        symposiumLog(`[surface] <- webview: ${message?.type}${message?.type === "send" ? ` (${(message.text ?? "").length} chars)` : ""}`);
        try {
            switch (message?.type) {
                case "ready": {
                    this.ready = true;
                    for (const queued of this.queue) {
                        void this.webview.postMessage(queued);
                    }
                    this.queue = [];
                    void this.refreshSessions();
                    // No dialogue chosen yet (e.g. the sidebar Chat view was just
                    // opened): start a fresh one so the composer is immediately live.
                    if (!this.controller) {
                        this.startDefaultDialogue();
                    }
                    return;
                }
                case "webview-error": {
                    symposiumLog(`[webview] ERROR: ${message.message}`);
                    return;
                }
                case "open-session": {
                    const sessions = await this.deps.listSessions();
                    const info = sessions.find((s) => s.sessionId === message.sessionId && s.backend === message.backend);
                    if (info) {
                        this.openSession(info);
                    }
                    return;
                }
                default: {
                    if (!this.controller && message?.type === "send") {
                        // Composer used before any dialogue was opened — start one now,
                        // then deliver this message to it.
                        this.startDefaultDialogue();
                    }
                    await this.controller?.handleMessage(message);
                }
            }
        } catch (error) {
            symposiumLog(`[surface] ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            void this.webview.postMessage({
                type: "event",
                event: { kind: "error", message: error instanceof Error ? error.message : String(error) },
            });
        }
    }

    /** Starts a new dialogue with the first available backend in the workspace cwd. */
    private startDefaultDialogue(): void {
        const backend = this.deps.adapterByBackend.keys().next().value;
        if (!backend) {
            return;
        }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this.openDialogue(backend, { cwd }, "New dialogue");
    }

    /** Opens a stored session (resume) in this surface. */
    openSession(info: SessionInfo): void {
        this.openDialogue(
            info.backend,
            { cwd: this.deps.cwdFor(info), resumeSessionId: info.sessionId },
            info.title,
            info,
        );
    }

    /** Opens a dialogue (new or resumed) in this surface. */
    openDialogue(backend: string, options: SessionStartOptions, title: string, info?: SessionInfo): void {
        const adapter = this.deps.adapterByBackend.get(backend);
        if (!adapter) {
            return;
        }
        this.controller?.dispose();
        this.post({ type: "clear" });
        this.controller = new ChatController(adapter, options, (message) => this.post(message));
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "left");
        this.post({
            type: "meta",
            backend: adapter.backend,
            resumed: !!options.resumeSessionId,
            models: adapter.models?.() ?? [],
            sessionId: options.resumeSessionId ?? "",
            title,
            sessionsSide,
        });
        if (info) {
            void this.controller.loadHistory(info);
        }
        this.onTitleChange?.(`${title} · ${adapter.backend}`);
    }

    async refreshSessions(): Promise<void> {
        const sessions = await this.deps.listSessions();
        this.post({
            type: "sessions",
            items: sessions.map((s) => ({
                backend: s.backend,
                sessionId: s.sessionId,
                title: s.title,
                updatedAt: s.updatedAt?.toISOString(),
            })),
        });
    }

    dispose(): void {
        this.controller?.dispose();
        this.controller = undefined;
    }
}
