import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AgentAdapter, SessionInfo, SessionStartOptions } from "../adapters/types";
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
        // Offer the active editor file as removable context; update on switch.
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() =>
            this.post({ type: "active-file", path: activeEditorFile() })));
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
                        delete: "symposium.deleteSession",
                    }[message.action as string];
                    if (command) {
                        await vscode.commands.executeCommand(command, info);
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
        this.detachActive();
        this.post({ type: "clear" });
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.post({
            type: "meta",
            backend: adapter.backend,
            backendName: (adapter as any).displayName,
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
            resumed: !!options.resumeSessionId,
            terminal: true,
            models: [],
            sessionId: options.resumeSessionId ?? "",
            title,
            sessionsSide,
            chatOnly: this.chatOnly,
            cwd: options.cwd,
            activeFile: activeEditorFile(),
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
            activeFile: activeEditorFile(),
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

    async refreshSessions(): Promise<void> {
        const sessions = await this.deps.listSessions();
        this.post({
            type: "sessions",
            items: sessions.map((s) => ({
                backend: s.backend,
                sessionId: s.sessionId,
                title: s.title,
                updatedAt: s.updatedAt?.toISOString(),
                archived: s.archived,
                status: s.status,
            })),
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
