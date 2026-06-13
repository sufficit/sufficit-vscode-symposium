import * as vscode from "vscode";
import { AgentAdapter, AgentEvent, AgentSession, SessionInfo, SessionStartOptions } from "../adapters/types";

type SendMode = "send" | "queue" | "steer";

interface PendingMessage {
    text: string;
    attachments: string[];
    model?: string;
    reasoning?: string;
}

/**
 * Backend-side state of one dialogue. Owns the agent process and KEEPS IT
 * RUNNING even when the user switches to another session: the controller
 * just detaches from the webview (buffering its output) and replays it on
 * re-attach. Only an explicit delete/dispose stops the process.
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
    private readonly log: unknown[] = [];   // replayable render messages
    private sink: ((message: unknown) => void) | null = null;

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
    ) { }

    /** The live session id, once the backend has reported it. */
    get sessionId(): string | undefined {
        return this.session?.sessionId ?? this.options.resumeSessionId;
    }

    get attached(): boolean {
        return this.sink !== null;
    }

    /**
     * Binds this controller to a webview sink and replays its render log.
     * Replaying the buffered user/turn-end/queued messages naturally restores
     * the busy/queued status in the webview.
     */
    attach(sink: (message: unknown) => void): void {
        this.sink = sink;
        for (const message of this.log) {
            sink(message);
        }
    }

    /** Stops forwarding to the webview but keeps the process running. */
    detach(): void {
        this.sink = null;
    }

    private emit(message: unknown): void {
        this.log.push(message);
        if (this.log.length > 5000) {
            this.log.shift();
        }
        this.sink?.(message);
    }

    async loadHistory(info: SessionInfo): Promise<void> {
        if (!this.adapter.history) {
            return;
        }
        try {
            const messages = await this.adapter.history(info);
            this.emit({ type: "history", messages });
        } catch (error) {
            this.emit({
                type: "event",
                event: { kind: "error", message: `failed to load history: ${error instanceof Error ? error.message : error}` },
            });
        }
    }

    async handleMessage(message: any): Promise<boolean> {
        switch (message?.type) {
            case "send":
                this.onSend(
                    { text: message.text, attachments: message.attachments ?? [], model: message.model, reasoning: message.reasoning },
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
                    // Not buffered: a transient UI affordance for the active view.
                    this.sink?.({
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
            this.queue.length = 0;
            this.queue.push(msg);
            this.session?.cancel();
            return;
        }
        if (this.busy) {
            this.queue.push(msg);
            this.emit({ type: "queued", count: this.queue.length });
            return;
        }
        this.dispatch(msg);
    }

    private dispatch(msg: PendingMessage): void {
        if (!this.session) {
            if (msg.model && msg.model !== "default" && msg.model !== "auto") {
                this.options.model = msg.model;
            }
            if (msg.reasoning && msg.reasoning !== "default") {
                this.options.reasoning = msg.reasoning;
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
        this.emit({ type: "user", text: msg.text, attachments: msg.attachments });
        this.session.send(fullText);
    }

    private onEvent(event: AgentEvent): void {
        this.emit({ type: "event", event });
        if (event.kind === "turn-end") {
            this.busy = false;
            const next = this.queue.shift();
            if (next) {
                this.emit({ type: "queued", count: this.queue.length });
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
