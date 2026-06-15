import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AgentAdapter, HistoryMessage, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { renderHtml } from "./chatHtml";
import { TerminalSession } from "./terminalSession";
import { LiveSessions } from "../sessions/runtime";
import { symposiumLog } from "../extension";
import { approveChange, gitRoot, headContent, pendingChanges, rejectChange } from "../git";
import { snapshots } from "../snapshots";

/** Directory to run git in for a file — git discovers the enclosing repo upward. */
function repoCwd(file: string): string {
    return path.dirname(file);
}

/** Path of the file in the active editor, if any (skips non-file/webview tabs). */
function activeEditorFile(): string | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    return doc && doc.uri.scheme === "file" ? doc.uri.fsPath : undefined;
}

/** Active-file context including a non-empty line selection (1-based, inclusive). */
function activeEditorContext(): { path?: string; start?: number; end?: number } {
    const ed = vscode.window.activeTextEditor;
    const path = ed && ed.document.uri.scheme === "file" ? ed.document.uri.fsPath : undefined;
    if (!path || !ed) { return { path }; }
    const sel = ed.selection;
    if (sel.isEmpty) { return { path }; }
    // A selection that ends at column 0 of a line doesn't include that line.
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return { path, start: sel.start.line + 1, end: endLine };
}

const IMAGE_EXT: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
};

/** Writes a pasted image (base64) to a temp file and returns its attachment descriptor. */
async function writePastedImage(mime: string, base64: string): Promise<{ path: string; name: string } | undefined> {
    if (!base64) {
        return undefined;
    }
    const ext = IMAGE_EXT[mime] ?? "png";
    const dir = path.join(os.tmpdir(), "symposium-pastes");
    await fs.promises.mkdir(dir, { recursive: true });
    const name = `paste-${Date.now()}.${ext}`;
    const full = path.join(dir, name);
    await fs.promises.writeFile(full, Buffer.from(base64, "base64"));
    symposiumLog(`[surface] pasted image saved: ${full}`);
    return { path: full, name };
}

export interface ChatSurfaceDeps {
    adapterByBackend: Map<string, AgentAdapter>;
    listSessions(): Promise<SessionInfo[]>;
    cwdFor(info: SessionInfo): string;
    runtime: LiveSessions;
    /** Remembers the last active session so it can be restored next launch. */
    lastActive: {
        get(): { backend: string; sessionId: string } | undefined;
        set(value: { backend: string; sessionId: string } | undefined): void;
    };
    /** Sufficit account for the sessions-pane footer (avatar + login/logout). */
    account?: {
        get(): Promise<{ name?: string; email?: string; picture?: string } | undefined>;
        onDidChange: vscode.Event<void>;
    };
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
    private gitWatcher: vscode.FileSystemWatcher | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly webview: vscode.Webview,
        private readonly deps: ChatSurfaceDeps,
        private readonly onTitleChange?: (title: string) => void,
        // Editor panels show only the open conversation; the sidebar shows the
        // sessions list beside it.
        private readonly chatOnly = false,
    ) {
        webview.options = { enableScripts: true };
        webview.html = renderHtml();
        webview.onDidReceiveMessage((message) => void this.onMessage(message));
        // Offer the active editor file (+ any line selection) as removable
        // context; update on editor switch and on selection change.
        const pushActiveFile = () => this.post({ type: "active-file", ...activeEditorContext() });
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(pushActiveFile));
        this.disposables.push(vscode.window.onDidChangeTextEditorSelection(pushActiveFile));
        if (this.deps.account) {
            this.disposables.push(this.deps.account.onDidChange(() => void this.pushAccount()));
        }
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
                    void this.pushAccount();
                    // Nothing bound yet (view just opened): restore the last
                    // active session if we have one, else start a fresh dialogue.
                    if (!this.controller && !this.followHandle && !this.terminalSession) {
                        void this.restoreOrStart();
                    }
                    return;
                }
                case "webview-error": {
                    symposiumLog(`[webview] ERROR: ${message.message}`);
                    return;
                }
                case "account-login": {
                    await vscode.commands.executeCommand("symposium.login");
                    return;
                }
                case "account-logout": {
                    await vscode.commands.executeCommand("symposium.logout");
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
                case "paste-image": {
                    const file = await writePastedImage(message.mime, message.data);
                    if (file) {
                        this.post({ type: "attachments-picked", files: [file] });
                    }
                    return;
                }
                case "new-session": {
                    await vscode.commands.executeCommand("symposium.newSession");
                    return;
                }
                case "list-backends": {
                    // Offer the agents the current dialogue can be handed off to
                    // (every configured backend except the one in use now). The
                    // current backend may come from a chat controller OR a
                    // terminal session.
                    const current = this.controller?.backend ?? this.terminalSession?.backend;
                    const items = [...this.deps.adapterByBackend.values()].map((adapter) => ({
                        backend: adapter.backend,
                        name: (adapter as any).displayName ?? adapter.backend,
                        current: adapter.backend === current,
                    }));
                    this.post({ type: "backends", items });
                    return;
                }
                case "switch-backend": {
                    if (typeof message.backend === "string") {
                        // A terminal session has no ChatController transcript, so
                        // its handoff reads the CLI transcript instead.
                        if (this.terminalSession && !this.controller) {
                            await this.switchBackendFromTerminal(message.backend);
                        } else {
                            this.switchBackend(message.backend);
                        }
                    }
                    return;
                }
                case "restart-from-message": {
                    if (typeof message.index === "number") {
                        this.restartFromMessage(message.index);
                    }
                    return;
                }
                case "open-settings": {
                    await vscode.commands.executeCommand("symposium.openSettings");
                    return;
                }
                case "open-file": {
                    if (typeof message.path === "string") {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                        await vscode.window.showTextDocument(doc, { preview: true });
                    }
                    return;
                }
                case "reorder-pinned": {
                    await vscode.commands.executeCommand("symposium.reorderPinned", message.ids ?? []);
                    return;
                }
                case "file-diff": {
                    await this.openFileDiff(message.path);
                    return;
                }
                case "file-approve": {
                    if (typeof message.path === "string") {
                        await this.approveFile(message.path);
                        this.refreshChangedNow();
                    }
                    return;
                }
                case "file-reject": {
                    if (typeof message.path === "string") {
                        if (await this.rejectFile(message.path)) { this.controller?.resolveChanged(message.path); }
                        else { void vscode.window.showWarningMessage("Could not revert " + message.path); }
                    }
                    return;
                }
                case "file-approve-all": {
                    for (const p of this.controller?.changedPaths() ?? []) {
                        await this.approveFile(p);
                    }
                    this.refreshChangedNow();
                    return;
                }
                case "file-reject-all": {
                    const paths = this.controller?.changedPaths() ?? [];
                    if (!paths.length) { return; }
                    const pick = await vscode.window.showWarningMessage(
                        `Revert ${paths.length} file(s) to their pre-edit state? This discards the agent's changes.`,
                        { modal: true }, "Revert");
                    if (pick !== "Revert") { return; }
                    for (const p of paths) {
                        if (await this.rejectFile(p)) { this.controller?.resolveChanged(p); }
                    }
                    return;
                }
                case "session-action": {
                    const sessions = await this.deps.listSessions();
                    const info = sessions.find((s) => s.sessionId === message.sessionId && s.backend === message.backend);
                    if (!info) {
                        return;
                    }
                    const command = {
                        open: "symposium.resumeInTerminal",
                        rename: "symposium.renameSession",
                        watch: "symposium.followSession",
                        archive: "symposium.archiveSession",
                        unarchive: "symposium.unarchiveSession",
                        pin: "symposium.pinSession",
                        unpin: "symposium.unpinSession",
                        pinUp: "symposium.pinUp",
                        pinDown: "symposium.pinDown",
                        delete: "symposium.deleteSession",
                    }[message.action as string];
                    if (command) {
                        await vscode.commands.executeCommand(command, info);
                    }
                    return;
                }
                case "session-list-backends": {
                    // "Continue with another agent" from a session's right-click
                    // menu: offer every configured backend except the session's own.
                    const items = [...this.deps.adapterByBackend.values()].map((adapter) => ({
                        backend: adapter.backend,
                        name: (adapter as any).displayName ?? adapter.backend,
                        current: adapter.backend === message.backend,
                    }));
                    this.post({ type: "session-backends", items });
                    return;
                }
                case "session-switch-backend": {
                    if (
                        typeof message.sessionId === "string" &&
                        typeof message.backend === "string" &&
                        typeof message.targetBackend === "string"
                    ) {
                        await this.switchBackendForSession(
                            message.sessionId,
                            message.backend,
                            message.targetBackend,
                        );
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
                    // Edit & resend: rewind to before the edited message, then send.
                    if (message?.type === "send" && message.editFrom != null && this.controller) {
                        this.editResend(message.editFrom, message);
                        return;
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

    /**
     * Restores the last active session (resumed from its transcript, with a
     * live controller reused if it is still running) or starts fresh.
     */
    private async restoreOrStart(): Promise<void> {
        const last = this.deps.lastActive.get();
        if (last) {
            const sessions = await this.deps.listSessions();
            const info = sessions.find((s) => s.sessionId === last.sessionId && s.backend === last.backend);
            if (info) {
                this.openSession(info);
                return;
            }
        }
        this.startDefaultDialogue();
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

    /**
     * Starts a fresh session on the SAME backend, seeded only with the visible
     * conversation up to the chosen message. This is the Symposium equivalent
     * of VS Code chat's "restart from here": the old dialogue remains intact,
     * while the current surface branches into a new one from that point.
     */
    private restartFromMessage(index: number): void {
        const from = this.controller;
        if (!from || !Number.isInteger(index) || index < 0) {
            return;
        }
        const messages = from.transcriptMessagesUpTo(index);
        if (!messages.length) {
            return;
        }
        const transcript = from.transcriptUpTo(index);
        const backend = from.backend;
        const title = from.title;
        const cwd = from.cwd;
        const seedHistory = transcript
            ? `[Conversation restarted from an earlier point] Continue this dialogue from the selected earlier message only. ` +
              `Treat the conversation below as the complete history so far. Do not mention the discarded later branch unless the user asks about it.\n\n` +
              `=== Conversation so far ===\n${transcript}\n=== End of conversation so far ===`
            : undefined;

        this.openDialogue(backend, { cwd, seedHistory }, title);
        this.post({
            type: "history",
            messages,
            carried: true,
            branchLabel: {
                title: "Branched from earlier message",
                detail: `${messages.length} message${messages.length === 1 ? "" : "s"} carried into this new conversation`,
            },
        });
    }

    /**
     * Edit & resend: branch a fresh session seeded with the conversation BEFORE
     * the edited message (anchorIndex excluded), then deliver the edited text as
     * the new message — so we genuinely "restart from this point".
     */
    private editResend(anchorIndex: number, sendMsg: any): void {
        const from = this.controller;
        if (!from || !Number.isInteger(anchorIndex) || anchorIndex < 0) {
            // Nothing to rewind to — treat as a normal send.
            void this.controller?.handleMessage({ ...sendMsg, editFrom: undefined });
            return;
        }
        const keepTo = anchorIndex - 1;   // exclude the message being edited
        const messages = from.transcriptMessagesUpTo(keepTo);
        const transcript = from.transcriptUpTo(keepTo);
        const seedHistory = transcript
            ? `[Conversation continued from an earlier point] Treat the conversation below as the complete history so far.\n\n` +
              `=== Conversation so far ===\n${transcript}\n=== End of conversation so far ===`
            : undefined;
        this.openDialogue(from.backend, { cwd: from.cwd, seedHistory }, from.title);
        if (messages.length) {
            this.post({ type: "history", messages, carried: true });
        }
        void this.controller?.handleMessage({
            type: "send",
            text: sendMsg.text,
            attachments: sendMsg.attachments ?? [],
            model: sendMsg.model,
            reasoning: sendMsg.reasoning,
            permission: sendMsg.permission,
            autonomy: sendMsg.autonomy,
            mode: "send",
        });
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
     * Hands the current dialogue off to another backend WITHOUT leaving the
     * screen: starts a fresh session on the target agent in this same surface,
     * seeded with the prior conversation, and replays the visible exchange so
     * it reads as one continuous dialogue. The original session keeps running
     * in the background (it is only detached), so it can be reopened later.
     */
    switchBackend(backend: string): void {
        const from = this.controller;
        if (!from || from.backend === backend) {
            return;
        }
        const target = this.deps.adapterByBackend.get(backend);
        if (!target) {
            return;
        }
        const fromName = (this.deps.adapterByBackend.get(from.backend) as any)?.displayName ?? from.backend;
        const transcript = from.transcript();
        const title = from.title;
        const cwd = from.cwd;

        const seedHistory = transcript
            ? `[Conversation handed off from ${fromName}] You are taking over an ongoing dialogue. ` +
              `Below is the conversation so far between the user and the previous agent. ` +
              `Continue seamlessly, as if you had been part of it from the start — do not restart or re-introduce yourself.\n\n` +
              `=== Prior conversation ===\n${transcript}\n=== End of prior conversation ===`
            : undefined;

        // Open the new dialogue in this surface (detaches the old controller,
        // which keeps running in the background), then replay the visible
        // history so the user sees an uninterrupted conversation.
        this.openDialogue(backend, { cwd, seedHistory }, title);
        if (transcript) {
            this.post({ type: "history", messages: from.transcriptMessages(), carried: true });
            const targetName = (target as any).displayName ?? backend;
            this.post({ type: "event", event: { kind: "text", text: `_↪ Conversation continued with **${targetName}** — the prior exchange above was carried over as context._` } });
            this.post({ type: "event", event: { kind: "turn-end" } });
        }
    }

    /**
     * Hands a TERMINAL session off to another backend. A terminal session has
     * no in-memory ChatController transcript (the CLI owns the conversation),
     * so the prior exchange is read back from the CLI's stored transcript via
     * the adapter's `history()`. The handoff then opens a regular chat dialogue
     * on the target backend seeded with that conversation. The original
     * terminal keeps running (it is only detached), so it can be reopened.
     */
    private async switchBackendFromTerminal(backend: string): Promise<void> {
        const from = this.terminalSession;
        if (!from || from.backend === backend) {
            return;
        }
        const target = this.deps.adapterByBackend.get(backend);
        if (!target) {
            return;
        }
        const fromName = (this.deps.adapterByBackend.get(from.backend) as any)?.displayName ?? from.backend;
        const cwd = from.cwd;
        const messages = await this.historyToRows(await from.historyMessages());
        const transcript = messages
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
            .join("\n\n");

        const seedHistory = transcript
            ? `[Conversation handed off from ${fromName}] You are taking over an ongoing dialogue. ` +
              `Below is the conversation so far between the user and the previous agent. ` +
              `Continue seamlessly, as if you had been part of it from the start — do not restart or re-introduce yourself.\n\n` +
              `=== Prior conversation ===\n${transcript}\n=== End of prior conversation ===`
            : undefined;

        this.openDialogue(backend, { cwd, seedHistory }, fromName);
        if (transcript) {
            this.post({ type: "history", messages, carried: true });
            const targetName = (target as any).displayName ?? backend;
            this.post({ type: "event", event: { kind: "text", text: `_↪ Conversation continued with **${targetName}** — the prior exchange above was carried over as context._` } });
            this.post({ type: "event", event: { kind: "turn-end" } });
        }
    }

    /**
     * Collapses adapter HistoryMessages down to plain user/assistant rows for a
     * handoff replay — tool rows are dropped (only the human-readable dialogue
     * is carried over), and consecutive same-role rows are kept as-is.
     */
    private async historyToRows(history: HistoryMessage[]): Promise<{ role: "user" | "assistant"; text: string }[]> {
        const rows: { role: "user" | "assistant"; text: string }[] = [];
        for (const m of history) {
            if ((m.role === "user" || m.role === "assistant") && m.text?.trim()) {
                rows.push({ role: m.role, text: m.text.trim() });
            }
        }
        return rows;
    }

    /**
     * Hands a STORED session (picked from the sessions list's right-click menu)
     * off to another backend. The session need not be the one open in this
     * surface: its prior exchange is read back from the source backend's stored
     * transcript via `history()`, then a fresh dialogue is opened on the target
     * backend in this surface, seeded with that conversation. The original
     * session is untouched (it stays stored and can still be resumed).
     */
    private async switchBackendForSession(
        sessionId: string,
        sourceBackend: string,
        targetBackend: string,
    ): Promise<void> {
        if (sourceBackend === targetBackend) {
            return;
        }
        const target = this.deps.adapterByBackend.get(targetBackend);
        const source = this.deps.adapterByBackend.get(sourceBackend);
        if (!target || !source) {
            return;
        }
        const sessions = await this.deps.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId && s.backend === sourceBackend);
        if (!info) {
            return;
        }
        const fromName = (source as any).displayName ?? sourceBackend;
        const cwd = this.deps.cwdFor(info);
        const history = source.history ? await source.history(info).catch(() => [] as HistoryMessage[]) : [];
        const messages = await this.historyToRows(history);
        const transcript = messages
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
            .join("\n\n");

        const seedHistory = transcript
            ? `[Conversation handed off from ${fromName}] You are taking over an ongoing dialogue. ` +
              `Below is the conversation so far between the user and the previous agent. ` +
              `Continue seamlessly, as if you had been part of it from the start — do not restart or re-introduce yourself.\n\n` +
              `=== Prior conversation ===\n${transcript}\n=== End of prior conversation ===`
            : undefined;

        this.openDialogue(targetBackend, { cwd, seedHistory }, info.title);
        if (transcript) {
            this.post({ type: "history", messages, carried: true });
            const targetName = (target as any).displayName ?? targetBackend;
            this.post({ type: "event", event: { kind: "text", text: `_↪ Conversation from **${fromName}** continued with **${targetName}** — the prior exchange above was carried over as context._` } });
            this.post({ type: "event", event: { kind: "turn-end" } });
        }
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
        this.detachActive();
        this.post({ type: "clear" });
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.post({
            type: "meta",
            backend: adapter.backend,
            backendName: (adapter as any).displayName,
            modelLabels: (adapter as any).modelLabels?.() ?? {},
            resumed: true,
            readOnly: true,
            models: [],
            sessionId: info.sessionId,
            title: info.title,
            sessionsSide,
            chatOnly: this.chatOnly,
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", "queue"),
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
    openTerminalDialogue(backend: string, options: SessionStartOptions & { env?: Record<string, string>; tmuxName?: string; reasoning?: string }, title: string): void {
        const adapter = this.deps.adapterByBackend.get(backend);
        if (!adapter) {
            return;
        }
        this.detachActive();
        this.post({ type: "clear" });
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.post({
            type: "meta",
            backend: adapter.backend,
            backendName: (adapter as any).displayName,
            modelLabels: (adapter as any).modelLabels?.() ?? {},
            resumed: !!options.resumeSessionId,
            terminal: true,
            models: [],
            sessionId: options.resumeSessionId ?? "",
            title,
            sessionsSide,
            chatOnly: this.chatOnly,
            cwd: options.cwd,
            activeFile: activeEditorContext().path,
            activeFileStart: activeEditorContext().start,
            activeFileEnd: activeEditorContext().end,
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", "queue"),
        });
        this.terminalSession = new TerminalSession(
            adapter,
            { cwd: options.cwd, resumeSessionId: options.resumeSessionId, model: options.model, reasoning: options.reasoning, env: options.env, tmuxName: options.tmuxName },
            (message) => this.post(message),
            symposiumLog,
        );
        if (options.tmuxName) {
            this.post({ type: "event", event: { kind: "tool-start", toolName: "tmux", detail: options.tmuxName + " — survives VS Code closing" } });
        }
        void this.terminalSession.start();
        this.postCommands(adapter);
        this.refreshModels(adapter);
        this.onTitleChange?.(`▷ ${title} · ${adapter.backend}`);
    }

    /**
     * Opens a dialogue (new or resumed) in this surface. Switching away from a
     * running session DETACHES it (it keeps working in the background) instead
     * of stopping it; returning to it re-attaches and replays its output.
     */
    openDialogue(backend: string, options: SessionStartOptions, title: string, info?: SessionInfo): void {
        const adapter = this.deps.adapterByBackend.get(backend);
        if (!adapter) {
            return;
        }
        this.detachActive();
        this.post({ type: "clear" });

        // Reuse a still-running controller for this session; else create one.
        const existing = options.resumeSessionId
            ? this.deps.runtime.findBySessionId(options.resumeSessionId)
            : undefined;
        const controller = existing ?? this.deps.runtime.create(adapter, options);
        this.controller = controller;

        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.post({
            type: "meta",
            backend: adapter.backend,
            backendName: (adapter as any).displayName,
            modelLabels: (adapter as any).modelLabels?.() ?? {},
            resumed: !!options.resumeSessionId,
            models: adapter.models?.() ?? [],
            reasoningLevels: adapter.reasoningLevels?.() ?? [],
            reasoningDefault: vscode.workspace.getConfiguration("symposium." + adapter.backend).get<string>("reasoning", "default"),
            modelDefault: vscode.workspace.getConfiguration("symposium." + adapter.backend).get<string>("model", ""),
            permissionModes: adapter.permissionModes?.() ?? [],
            permission: adapter.defaultPermission?.() ?? "default",
            sessionId: options.resumeSessionId ?? "",
            title,
            sessionsSide,
            chatOnly: this.chatOnly,
            cwd: options.cwd,
            activeFile: activeEditorContext().path,
            activeFileStart: activeEditorContext().start,
            activeFileEnd: activeEditorContext().end,
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", "queue"),
        });
        controller.attach((message) => {
            // The controller emits the RAW edited-files set; the surface filters
            // it against live git status (so staged files drop, unstaging them
            // brings them back) before showing it.
            if ((message as any)?.type === "changed-files") {
                void this.refreshChanged((message as any).items);
                return;
            }
            // Capture a freshly-assigned session id so a brand-new dialogue
            // also becomes the restorable "last active" one.
            const ev = (message as any)?.event;
            if (ev?.kind === "session" && ev.sessionId) {
                this.deps.lastActive.set({ backend, sessionId: ev.sessionId });
            }
            this.post(message);
        });
        if (!existing && info) {
            void controller.loadHistory(info);
        }
        if (options.resumeSessionId) {
            this.deps.lastActive.set({ backend, sessionId: options.resumeSessionId });
        }
        this.postCommands(adapter);
        this.refreshModels(adapter);
        this.onTitleChange?.(`${title} · ${adapter.backend}`);
    }

    /** Fetches the backend's slash commands/skills and sends them for autocomplete. */
    private postCommands(adapter: AgentAdapter): void {
        if (!adapter.commands) {
            this.post({ type: "commands", items: [] });
            return;
        }
        void adapter.commands()
            .then((items) => this.post({ type: "commands", items }))
            .catch(() => this.post({ type: "commands", items: [] }));
    }

    /**
     * The `meta` message carries `adapter.models()` synchronously, which for
     * remote-discovery backends (OpenAI-compatible) may be a stale/fallback
     * list when the discovery cache is still empty — e.g. the first session
     * opened after a reload. This kicks off an async refresh and posts an
     * updated `models` message so the picker repopulates once discovery lands.
     */
    private refreshModels(adapter: AgentAdapter): void {
        if (!adapter.refreshModels) {
            return;
        }
        const backend = adapter.backend;
        void adapter.refreshModels()
            .then(({ models, labels }) => {
                // Only the dialogue still bound to this backend should apply it
                // (the user may have switched agents while discovery ran).
                const current = this.controller?.backend ?? this.terminalSession?.backend;
                if (current !== backend || !models?.length) {
                    return;
                }
                this.post({ type: "models", models, labels: labels ?? {} });
            })
            .catch(() => undefined);
    }

    /** Pushes the Sufficit account (or null) for the sessions-pane footer. */
    private async pushAccount(): Promise<void> {
        if (!this.deps.account) {
            return;
        }
        const profile = await this.deps.account.get().catch(() => undefined);
        this.post({ type: "account", profile: profile ?? null });
    }

    async refreshSessions(): Promise<void> {
        const sessions = await this.deps.listSessions();
        // Forward the whole SessionInfo (only normalize the Date) — no field
        // whitelist, which previously dropped new fields (pinned, etc.).
        this.post({
            type: "sessions",
            items: sessions.map((s) => ({ ...s, updatedAt: s.updatedAt?.toISOString() })),
        });
    }

    /**
     * Unbinds the current dialogue from this surface WITHOUT stopping it: the
     * headless controller keeps running in the shared runtime (re-attached on
     * return). The terminal/follow mirrors are surface-bound and torn down
     * (the terminal panel itself stays open).
     */
    private detachActive(): void {
        this.controller?.detach();
        this.controller = undefined;
        this.terminalSession?.dispose();
        this.terminalSession = undefined;
        this.followHandle?.dispose();
        this.followHandle = undefined;
    }

    /** Working directory of the active session (for git operations). */
    private cwd(): string {
        return this.controller?.cwd
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ?? process.cwd();
    }

    /** Active session id (snapshots are keyed by it). */
    private sid(): string {
        return this.controller?.sessionId ?? "";
    }

    /**
     * Accepts a file's changes. The session snapshot baseline is dropped so it
     * can't be reverted anymore; if the file is in a git repo we also stage it.
     */
    private async approveFile(filePath: string): Promise<void> {
        // In a git repo, approve = stage (git add). The file then has no
        // unstaged change, so the git-status filter hides it — and unstaging in
        // git brings it back. Outside a repo, drop it from the set directly.
        if (await gitRoot(repoCwd(filePath))) {
            await approveChange(repoCwd(filePath), filePath);
        } else {
            this.controller?.resolveChanged(filePath);
        }
    }

    /**
     * Filters the controller's raw edited-files set against live git status and
     * pushes the result to the webview. Also (re)arms a watcher on the repos'
     * index so staging/unstaging in git or the SCM view syncs back here.
     */
    private async refreshChanged(rawItems: { path: string; added: number; removed: number }[]): Promise<void> {
        const paths = rawItems.map((i) => i.path);
        const pending = await pendingChanges(paths);
        this.post({ type: "changed-files", items: rawItems.filter((i) => pending.has(i.path)) });
        this.ensureGitWatcher();
    }

    /** Recomputes the displayed set from the controller's current raw set. */
    private refreshChangedNow(): void {
        void this.refreshChanged(this.controller?.changedItemsRaw() ?? []);
    }

    /** Watches workspace git indexes so external stage/unstage re-syncs the list. */
    private ensureGitWatcher(): void {
        if (this.gitWatcher) { return; }
        this.gitWatcher = vscode.workspace.createFileSystemWatcher("**/.git/index");
        const onGit = () => {
            if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
            this.refreshTimer = setTimeout(() => this.refreshChangedNow(), 250);
        };
        this.gitWatcher.onDidChange(onGit);
        this.gitWatcher.onDidCreate(onGit);
        this.gitWatcher.onDidDelete(onGit);
        this.disposables.push(this.gitWatcher);
    }

    /**
     * Reverts a file to its pre-edit state. Prefers the session snapshot (works
     * with or without git, even for new files); falls back to git restore for
     * resumed sessions that have no snapshot.
     */
    private async rejectFile(filePath: string): Promise<boolean> {
        if (snapshots.has(this.sid(), filePath)) {
            return snapshots.revert(this.sid(), filePath);
        }
        if (await gitRoot(repoCwd(filePath))) {
            return rejectChange(repoCwd(filePath), filePath);
        }
        void vscode.window.showWarningMessage(
            "No pre-edit snapshot for this file (edited before this session started) and it's not in a git repo, so it can't be reverted: " + filePath);
        return false;
    }

    /**
     * Diffs an edited file against its baseline: the session snapshot if we have
     * one, else the git HEAD version. New files with no baseline just open.
     */
    private async openFileDiff(filePath: unknown): Promise<void> {
        if (typeof filePath !== "string") { return; }
        const fileUri = vscode.Uri.file(filePath);
        const name = path.basename(filePath);
        let base: string | null | undefined = snapshots.baseline(this.sid(), filePath);
        let label = "before ↔ now";
        if (base === undefined) {
            base = await headContent(repoCwd(filePath), filePath);
            label = "HEAD ↔ working";
        }
        if (base === undefined || base === null) {
            await vscode.window.showTextDocument(fileUri, { preview: true });
            return;
        }
        const tmp = path.join(os.tmpdir(), "symposium-diff");
        await fs.promises.mkdir(tmp, { recursive: true });
        const baseFile = path.join(tmp, `base-${Date.now()}-${name}`);
        await fs.promises.writeFile(baseFile, base);
        await vscode.commands.executeCommand(
            "vscode.diff", vscode.Uri.file(baseFile), fileUri, `${name} (${label})`);
    }

    dispose(): void {
        // Detach only — the runtime owns controller lifetimes so sessions
        // survive the view/panel being closed.
        this.detachActive();
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
    }
}
