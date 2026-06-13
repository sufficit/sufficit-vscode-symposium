import * as vscode from "vscode";
import { AgentAdapter, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { renderHtml } from "./chatHtml";
import { TerminalSession } from "./terminalSession";
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
    private terminalSession: TerminalSession | undefined;
    private followHandle: { dispose(): void } | undefined;
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
                    // Skip when mirroring (follow) or driving a terminal session.
                    if (!this.controller && !this.followHandle && !this.terminalSession) {
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
                    if (this.terminalSession && message?.type === "send") {
                        this.terminalSession.send(message.text);
                        return;
                    }
                    if (this.terminalSession && message?.type === "cancel") {
                        return; // the user interrupts in the terminal itself
                    }
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

    /**
     * Read-only live mirror of a session running elsewhere (e.g. an
     * interactive terminal). Shows the stored history, then tails the
     * transcript so new turns appear as they happen. The composer is
     * disabled — sending would fork the session, not drive the original.
     */
    async followSession(info: SessionInfo): Promise<void> {
        const adapter = this.deps.adapterByBackend.get(info.backend);
        if (!adapter?.follow) {
            // No live mirror for this backend — fall back to resume.
            this.openSession(info);
            return;
        }
        this.disposeActive();
        this.post({ type: "clear" });
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "left");
        this.post({
            type: "meta",
            backend: adapter.backend,
            resumed: true,
            readOnly: true,
            models: [],
            sessionId: info.sessionId,
            title: info.title,
            sessionsSide,
        });
        if (adapter.history) {
            try {
                const messages = await adapter.history(info);
                this.post({ type: "history", messages });
            } catch {
                // ignore; live tail still attaches below
            }
        }
        this.followHandle = adapter.follow(info, (message) => {
            this.post({ type: "append", message });
        });
        this.onTitleChange?.(`👁 ${info.title} · ${adapter.backend}`);
    }

    /**
     * Terminal-backed dialogue: Symposium launches the CLI in a visible VS
     * Code terminal it owns, so the composer drives the same interactive
     * process the user can also type into. Full two-way control of one live
     * session. `env`/`model` come from the adapter's configuration.
     */
    openTerminalDialogue(backend: string, options: SessionStartOptions & { env?: Record<string, string> }, title: string): void {
        const adapter = this.deps.adapterByBackend.get(backend);
        if (!adapter) {
            return;
        }
        this.disposeActive();
        this.post({ type: "clear" });
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "left");
        this.post({
            type: "meta",
            backend: adapter.backend,
            resumed: !!options.resumeSessionId,
            terminal: true,
            models: [],
            sessionId: options.resumeSessionId ?? "",
            title,
            sessionsSide,
        });
        this.terminalSession = new TerminalSession(
            adapter,
            { cwd: options.cwd, resumeSessionId: options.resumeSessionId, model: options.model, env: options.env },
            (message) => this.post(message),
            symposiumLog,
        );
        void this.terminalSession.start();
        this.onTitleChange?.(`▷ ${title} · ${adapter.backend}`);
    }

    /** Opens a dialogue (new or resumed) in this surface. */
    openDialogue(backend: string, options: SessionStartOptions, title: string, info?: SessionInfo): void {
        const adapter = this.deps.adapterByBackend.get(backend);
        if (!adapter) {
            return;
        }
        this.disposeActive();
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

    /** Tears down whatever dialogue is currently active in this surface. */
    private disposeActive(): void {
        this.controller?.dispose();
        this.controller = undefined;
        this.terminalSession?.dispose();
        this.terminalSession = undefined;
        this.followHandle?.dispose();
        this.followHandle = undefined;
    }

    dispose(): void {
        this.disposeActive();
    }
}
