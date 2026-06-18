import * as vscode from "vscode";
import { AgentAdapter, AgentEvent, AgentSession, SessionInfo, SessionStartOptions } from "../adapters/types";
import { parseTodoFence } from "../adapters/todos";
import { buildOutboundPrompt } from "./outboundPrompt";

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
    private outboundPolicyInjected = false;
    private todoInjected = false;
    private autonomyInjected = false;
    private seedInjected = false;
    private rtkInjected = false;
    private queueSeq = 0;
    // Files this session edited and their net +/- — owned here so it survives
    // view switches (the runtime keeps the controller alive) and approval state
    // isn't lost to a transcript replay.
    private readonly changed = new Map<string, { added: number; removed: number }>();
    private readonly queue: PendingMessage[] = [];
    private readonly log: unknown[] = [];   // replayable render messages
    private sink: ((message: unknown) => void) | null = null;
    // Read-only followers (public API / remote bridge) that observe the same
    // render stream as the active webview without stealing it. The webview uses
    // attach()/sink; observers use subscribe().
    private readonly observers = new Set<(message: unknown) => void>();

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

    /**
     * Reconstructs the visible conversation (user prompts + assistant replies)
     * from the render log as plain text, for handing the dialogue off to another
     * backend. Tool calls and internal scaffolding are intentionally omitted —
     * only the human-readable exchange is carried over.
     */
    transcript(): string {
        const lines: string[] = [];
        let assistantBuf = "";
        const flushAssistant = () => {
            const text = assistantBuf.trim();
            if (text) { lines.push(`Assistant: ${text}`); }
            assistantBuf = "";
        };
        for (const message of this.log as any[]) {
            if (message?.type === "user" && typeof message.text === "string") {
                flushAssistant();
                const text = message.text.trim();
                if (text) { lines.push(`User: ${text}`); }
            } else if (message?.type === "event" && message.event?.kind === "text") {
                assistantBuf += message.event.text;
            } else if (message?.type === "event" && message.event?.kind === "turn-end") {
                flushAssistant();
            }
        }
        flushAssistant();
        return lines.join("\n\n");
    }

    /**
     * The visible conversation as renderable history rows (user prompts +
     * assistant replies), used to repaint the prior exchange in the same
     * surface after a backend handoff. Tool rows are omitted — only the
     * human-readable dialogue is carried over.
     */
    transcriptMessages(): { role: "user" | "assistant"; text: string }[] {
        const rows: { role: "user" | "assistant"; text: string }[] = [];
        let assistantBuf = "";
        const flushAssistant = () => {
            const text = assistantBuf.trim();
            if (text) { rows.push({ role: "assistant", text }); }
            assistantBuf = "";
        };
        for (const message of this.log as any[]) {
            if (message?.type === "user" && typeof message.text === "string") {
                flushAssistant();
                const text = message.text.trim();
                if (text) { rows.push({ role: "user", text }); }
            } else if (message?.type === "event" && message.event?.kind === "text") {
                assistantBuf += message.event.text;
            } else if (message?.type === "event" && message.event?.kind === "turn-end") {
                flushAssistant();
            }
        }
        flushAssistant();
        return rows;
    }

    /** Visible user/assistant rows up to and including `index` (0-based). */
    transcriptMessagesUpTo(index: number): { role: "user" | "assistant"; text: string }[] {
        if (index < 0) {
            return [];
        }
        return this.transcriptMessages().slice(0, index + 1);
    }

    /** Plain-text transcript up to and including `index` (0-based). */
    transcriptUpTo(index: number): string {
        return this.transcriptMessagesUpTo(index)
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
            .join("\n\n");
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
        // The edited-files set is controller state (not in the replay log), so
        // push it after replay — this is what keeps approvals from "coming back"
        // when switching away and back.
        this.emitChanged();
    }

    /** Stops forwarding to the webview but keeps the process running. */
    detach(): void {
        this.sink = null;
    }

    /**
     * Subscribes a read-only follower to the render stream and replays the log
     * so a late joiner (remote viewer) sees the full conversation. Returns an
     * unsubscribe function. Does not affect the active webview sink.
     */
    subscribe(observer: (message: unknown) => void): () => void {
        this.observers.add(observer);
        for (const message of this.log) {
            observer(message);
        }
        return () => { this.observers.delete(observer); };
    }

    private emit(message: unknown): void {
        this.log.push(message);
        if (this.log.length > 5000) {
            this.log.shift();
        }
        this.sink?.(message);
        for (const observer of this.observers) {
            observer(message);
        }
    }

    /** Sends a message to this session programmatically (public API / bridge). */
    sendText(text: string, mode: SendMode = "send"): void {
        this.onSend({ text, attachments: [] }, mode);
    }

    /** Interrupts the running turn, if any (public API / bridge). */
    interrupt(): void {
        this.session?.cancel();
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
                // "Send next": jump this message to the front and deliver it now —
                // interrupt the running turn (it dispatches on turn-end), or send
                // immediately if idle. Other queued messages keep their order.
                const i = this.queue.findIndex((m) => m.id === message.id);
                if (i < 0) { return true; }
                const [m] = this.queue.splice(i, 1);
                if (this.busy) {
                    this.queue.unshift(m);   // dispatched first on turn-end
                    this.emitQueue();
                    this.session?.cancel();
                } else {
                    this.emitQueue();
                    this.dispatch(m);
                }
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
        // Apply per-message model/reasoning to the live options BEFORE (re)starting
        // or sending. Stateless backends (OpenAI HTTP) read options.model on each
        // request, so this lets the user switch model between messages. A running
        // CLI process keeps its spawn-time model (it's pinned there).
        if (msg.model && msg.model !== "default" && msg.model !== "auto") {
            this.options.model = msg.model;
        }
        if (msg.reasoning && msg.reasoning !== "default") {
            this.options.reasoning = msg.reasoning;
        }
        if (msg.permission) {
            this.options.permission = msg.permission;
        }
        // Presence drives unbounded tool loops for API backends (autonomous mode).
        this.options.autonomy = msg.autonomy;
        if (!this.session) {
            this.session = this.adapter.start(this.options);
            this.session.on("event", (event: AgentEvent) => this.onEvent(event));
        }
        // Images are inlined as vision blocks when the backend supports it
        // (more reliable than asking the agent to Read them from disk).
        const isImage = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);
        const canVision = this.adapter.supportsImages?.() === true;
        const images = canVision ? msg.attachments.filter(isImage) : [];
        const fileAtts = canVision ? msg.attachments.filter((p) => !isImage(p)) : msg.attachments;
        // Role-aware backends (HTTP API) carry one-shot app instructions as
        // `developer` messages; CLIs get them prepended to the user text.
        const roleAware = this.adapter.roleAware?.() === true;
        const outbound = buildOutboundPrompt({
            text: msg.text,
            fileAttachments: fileAtts,
            policyInjected: this.outboundPolicyInjected,
            todoInjected: this.todoInjected,
            seedInjected: this.seedInjected,
            autonomyInjected: this.autonomyInjected,
            rtkInjected: this.rtkInjected,
            rtk: true,
            todoInjection: this.adapter.hasNativeTodo?.() === false ? this.adapter.todoInjection?.() : undefined,
            seedHistory: this.options.seedHistory,
            autonomy: msg.autonomy,
            asRoles: roleAware,
        });
        this.outboundPolicyInjected = outbound.state.policyInjected;
        this.todoInjected = outbound.state.todoInjected;
        this.seedInjected = outbound.state.seedInjected;
        this.autonomyInjected = outbound.state.autonomyInjected;
        this.rtkInjected = !!outbound.state.rtkInjected;
        if (!this.firstTitle && msg.text.trim()) { this.firstTitle = msg.text.trim().slice(0, 60); }
        this.busy = true;
        this.onStatusChange?.();
        this.emit({ type: "user", text: msg.text, attachments: msg.attachments });
        this.session.send(outbound.text, images, outbound.preamble);
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
