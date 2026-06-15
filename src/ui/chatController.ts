import * as vscode from "vscode";
import { AgentAdapter, AgentEvent, AgentSession, SessionInfo, SessionStartOptions } from "../adapters/types";
import { parseTodoFence } from "../adapters/todos";

type SendMode = "send" | "queue" | "steer";

interface PendingMessage {
    id?: number;
    text: string;
    attachments: string[];
    model?: string;
    reasoning?: string;
    permission?: string;
    autonomy?: string;
}

// Injected once when the user marks themselves "away": full autonomy, no prompts.
const AUTONOMY_PREAMBLE =
    "[Autonomy mode] The user is not present to answer questions or make decisions and has given you full autonomy. " +
    "Do not wait for input or use interactive prompts (e.g. AskUserQuestion); make reasonable assumptions, decide, " +
    "and carry the task through end-to-end. Briefly state any assumptions and keep going.";

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
    private firstTitle = "";
    private todoInjected = false;
    private autonomyInjected = false;
    private queueSeq = 0;
    // Files this session edited and their net +/- — owned here so it survives
    // view switches (the runtime keeps the controller alive) and approval state
    // isn't lost to a transcript replay.
    private readonly changed = new Map<string, { added: number; removed: number }>();
    private readonly queue: PendingMessage[] = [];
    private readonly log: unknown[] = [];   // replayable render messages
    private sink: ((message: unknown) => void) | null = null;

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        // Fired when the running/idle state changes, so the sessions list can
        // update its per-session working indicator.
        private readonly onStatusChange?: () => void,
    ) { }

    /** The live session id, once the backend has reported it. */
    get sessionId(): string | undefined {
        return this.session?.sessionId ?? this.options.resumeSessionId;
    }

    /** True while a turn is running (agent working). */
    get isBusy(): boolean {
        return this.busy;
    }

    get backend(): string { return this.adapter.backend; }
    get cwd(): string { return this.options.cwd; }
    /** First user message, used as a title for a not-yet-persisted live session. */
    get title(): string { return this.firstTitle || "New session"; }

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
        // The edited-files set is controller state (not in the replay log), so
        // push it after replay — this is what keeps approvals from "coming back"
        // when switching away and back.
        this.emitChanged();
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
                    { text: message.text, attachments: message.attachments ?? [], model: message.model, reasoning: message.reasoning, permission: message.permission, autonomy: message.autonomy },
                    (message.mode as SendMode) ?? "send",
                );
                return true;
            case "cancel":
                this.session?.cancel();
                return true;
            case "queue-remove": {
                const i = this.queue.findIndex((m) => m.id === message.id);
                if (i >= 0) { this.queue.splice(i, 1); this.emitQueue(); }
                return true;
            }
            case "queue-edit": {
                // Pull a queued message back into the composer for editing and
                // drop it from the queue (the user re-sends after editing).
                const i = this.queue.findIndex((m) => m.id === message.id);
                if (i >= 0) {
                    const [m] = this.queue.splice(i, 1);
                    this.emitQueue();
                    this.sink?.({ type: "load-input", text: m.text, attachments: m.attachments });
                }
                return true;
            }
            case "queue-promote": {
                // Move a queued message to the front so it's dispatched next.
                const i = this.queue.findIndex((m) => m.id === message.id);
                if (i > 0) { const [m] = this.queue.splice(i, 1); this.queue.unshift(m); this.emitQueue(); }
                return true;
            }
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
            msg.id = ++this.queueSeq;
            this.queue.push(msg);
            this.emitQueue();
            return;
        }
        this.dispatch(msg);
    }

    /** Full queue state (editable until dispatched), reflected in the webview. */
    private emitQueue(): void {
        this.emit({ type: "queue", items: this.queue.map((m) => ({ id: m.id, text: m.text, attachments: m.attachments })) });
    }

    private dispatch(msg: PendingMessage): void {
        if (!this.session) {
            if (msg.model && msg.model !== "default" && msg.model !== "auto") {
                this.options.model = msg.model;
            }
            if (msg.reasoning && msg.reasoning !== "default") {
                this.options.reasoning = msg.reasoning;
            }
            if (msg.permission) {
                this.options.permission = msg.permission;
            }
            this.session = this.adapter.start(this.options);
            this.session.on("event", (event: AgentEvent) => this.onEvent(event));
        }
        let fullText = msg.text;
        if (msg.attachments.length) {
            fullText += "\n\nAttached files (read them from disk):\n" +
                msg.attachments.map((p) => `- ${p}`).join("\n");
        }
        // Inject a todo capability once, for CLIs without a native plan tool.
        if (!this.todoInjected && this.adapter.hasNativeTodo?.() === false) {
            const inj = this.adapter.todoInjection?.();
            if (inj) { fullText = inj + "\n\n---\n\n" + fullText; }
            this.todoInjected = true;
        }
        // Autonomy: prepend the preamble once per "away" streak; reset on return.
        if (msg.autonomy === "away") {
            if (!this.autonomyInjected) { fullText = AUTONOMY_PREAMBLE + "\n\n---\n\n" + fullText; this.autonomyInjected = true; }
        } else {
            this.autonomyInjected = false;
        }
        if (!this.firstTitle && msg.text.trim()) { this.firstTitle = msg.text.trim().slice(0, 60); }
        this.busy = true;
        this.onStatusChange?.();
        this.emit({ type: "user", text: msg.text, attachments: msg.attachments });
        this.session.send(fullText);
    }

    private onEvent(event: AgentEvent): void {
        this.emit({ type: "event", event });
        // Track edited files here (authoritative, survives view switches).
        if (event.kind === "tool-start" && event.path && (event.added != null || event.removed != null)) {
            const cur = this.changed.get(event.path) ?? { added: 0, removed: 0 };
            cur.added += event.added ?? 0; cur.removed += event.removed ?? 0;
            this.changed.set(event.path, cur);
            this.emitChanged();
        }
        // For CLIs with no native todo tool, recognize a fenced ```todo block in
        // the agent's text and surface it as a plan update.
        if (event.kind === "text" && this.adapter.hasNativeTodo?.() === false) {
            const todos = parseTodoFence(event.text);
            if (todos) {
                this.emit({ type: "event", event: { kind: "tool-start", toolName: "TodoWrite", detail: "", todos } });
            }
        }
        if (event.kind === "turn-end") {
            this.busy = false;
            this.onStatusChange?.();
            const next = this.queue.shift();
            if (next) {
                this.emitQueue();
                this.dispatch(next);
            }
        }
    }

    /** Signals the surface to re-derive the displayed edited-files set. */
    private emitChanged(): void {
        this.sink?.({ type: "changed-files", items: this.changedItemsRaw() });
    }

    /** Paths still pending review (for bulk approve/reject). */
    changedPaths(): string[] {
        return [...this.changed.keys()];
    }

    /** The raw edited-files set (before git-status filtering by the surface). */
    changedItemsRaw(): { path: string; added: number; removed: number }[] {
        return [...this.changed.entries()].map(([path, c]) => ({ path, added: c.added, removed: c.removed }));
    }

    /** Drops a file from the set after it's approved or reverted. */
    resolveChanged(path: string): void {
        if (this.changed.delete(path)) { this.emitChanged(); }
    }

    dispose(): void {
        this.session?.dispose();
        this.session = undefined;
        this.queue.length = 0;
    }
}
