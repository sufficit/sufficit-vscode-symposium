import * as vscode from "vscode";
import { AgentAdapter, AgentEvent, AgentSession, SessionInfo, SessionStartOptions } from "../adapters/types";

type SendMode = "send" | "queue" | "steer";

interface PendingMessage {
    text: string;
    attachments: string[];
    model?: string;
}

/**
 * Backend-side state of one dialogue, independent of the webview surface
 * (sidebar view or editor panel). Owns the agent process; the webview is a
 * thin renderer fed through `post`.
 *
 * Send modes (mirroring VS Code chat):
 *   - send : start now when idle; if a turn is running, it is queued.
 *   - queue: always wait for the current turn, then send (FIFO).
 *   - steer: interrupt the running turn and send immediately.
 */
export class ChatController {
    private session: AgentSession | undefined;
    private busy = false;
    private readonly queue: PendingMessage[] = [];

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        private readonly post: (message: unknown) => void,
    ) { }

    async loadHistory(info: SessionInfo): Promise<void> {
        if (!this.adapter.history) {
            return;
        }
        try {
            const messages = await this.adapter.history(info);
            this.post({ type: "history", messages });
        } catch (error) {
            this.post({
                type: "event",
                event: { kind: "error", message: `failed to load history: ${error instanceof Error ? error.message : error}` },
            });
        }
    }

    async handleMessage(message: any): Promise<boolean> {
        switch (message?.type) {
            case "send":
                this.onSend(
                    { text: message.text, attachments: message.attachments ?? [], model: message.model },
                    (message.mode as SendMode) ?? "send",
                );
                return true;
            case "cancel":
                this.session?.cancel();
                return true;
            case "pick-attachments": {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: true,
                    openLabel: "Attach",
                    title: "Attach files to the message",
                });
                if (picked?.length) {
                    this.post({
                        type: "attachments-picked",
                        files: picked.map((uri) => ({
                            path: uri.fsPath,
                            name: uri.path.split("/").pop() ?? uri.fsPath,
                        })),
                    });
                }
                return true;
            }
        }
        return false;
    }

    private onSend(msg: PendingMessage, mode: SendMode): void {
        if (mode === "steer" && this.busy) {
            // Interrupt the running turn, then send this message fresh. Set the
            // queue up BEFORE cancelling: cancel() leads to a turn-end that
            // flushes the queue, and we want only this message to run next.
            this.queue.length = 0;
            this.queue.push(msg);
            this.session?.cancel();
            return;
        }
        if (this.busy) {
            // send + queue both wait for the current turn.
            this.queue.push(msg);
            this.post({ type: "queued", count: this.queue.length });
            return;
        }
        this.dispatch(msg);
    }

    private dispatch(msg: PendingMessage): void {
        if (!this.session) {
            if (msg.model && msg.model !== "default" && msg.model !== "auto") {
                this.options.model = msg.model;
            }
            this.session = this.adapter.start(this.options);
            this.session.on("event", (event: AgentEvent) => this.onEvent(event));
        }
        let fullText = msg.text;
        if (msg.attachments.length) {
            fullText += "\n\nAttached files (read them from disk):\n" +
                msg.attachments.map((p) => `- ${p}`).join("\n");
        }
        this.busy = true;
        this.post({ type: "user", text: msg.text, attachments: msg.attachments });
        this.session.send(fullText);
    }

    private onEvent(event: AgentEvent): void {
        this.post({ type: "event", event });
        if (event.kind === "turn-end") {
            this.busy = false;
            const next = this.queue.shift();
            if (next) {
                this.post({ type: "queued", count: this.queue.length });
                this.dispatch(next);
            }
        }
    }

    dispose(): void {
        this.session?.dispose();
        this.session = undefined;
        this.queue.length = 0;
    }
}
