import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AgentAdapter, FollowHandle, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { WebviewToHost } from "./protocol";
import { renderHtml } from "./chatHtml";
import { TerminalSession } from "./terminalSession";
import { LiveSessions } from "../sessions/runtime";
import { symposiumLog } from "../extension";
import { ledgerDir } from "../ledger";
import { ChangedFilesManager } from "./changedFiles";
import { BackendHandoff } from "./backendHandoff";
import { HubClient } from "../sync/hubClient";
import { readWorkspaceBootstrap } from "../config/root";
import { probeRtk } from "../adapters/rtk";
import { fetchSessionTasks, setTaskDone, TaskItem } from "../sync/tasks";
import { fetchSessionGuardrails, removeGuardrail, clearSessionGuardrails } from "../sync/guardrails";
import {
    activeEditorContext,
    attachmentFromUri,
    isSimpleBrowserOpen,
    writeDroppedFile,
    writePastedImage,
} from "./chatSurfaceContext";

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
    /** Per-adapter model preferences: pinned list + default override. */
    modelPrefs: {
        getPinned(backend: string): string[];
        setPinned(backend: string, models: string[]): void;
        setDefault(backend: string, model: string | undefined): Thenable<void>;
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
    private followHandle: FollowHandle | undefined;
    private followedSessionId: string | undefined;
    private ready = false;
    private loggedIn = false;   // cached Sufficit login state (for system hints)
    private queue: unknown[] = [];

    private readonly disposables: vscode.Disposable[] = [];
    private readonly changedFiles = new ChangedFilesManager({ post: (m) => this.post(m), getCwd: () => this.cwd(), getSid: () => this.sid(), resolveChanged: (p) => this.controller?.resolveChanged(p), getRawItems: () => this.controller?.changedItemsRaw() ?? [] }, this.disposables);
    private readonly handoff = new BackendHandoff({ getAdapter: (b) => this.deps.adapterByBackend.get(b), listSessions: () => this.deps.listSessions(), cwdFor: (i) => this.deps.cwdFor(i), openDialogue: (b, o, t) => this.openDialogue(b, o, t), post: (m) => this.post(m), getController: () => this.controller, getTerminalSession: () => this.terminalSession });

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
        // The "attach browser page" button only makes sense while a Simple
        // Browser tab is open; toggle it as tabs come and go.
        this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(
            () => this.post({ type: "browser-state", open: isSimpleBrowserOpen() })));
        if (this.deps.account) {
            this.disposables.push(this.deps.account.onDidChange(() => void this.pushAccount()));
        }
        // Live-apply preference changes (e.g. sessions side) without a reload.
        this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("symposium.chat.sessionsSide")) {
                this.post({ type: "prefs", sessionsSide: vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto") });
            }
        }));
    }

    private post(message: unknown): void {
        symposiumLog(`[surface] -> webview: ${(message as any)?.type}${this.ready ? "" : " (queued)"}`);
        if (this.ready) {
            void this.webview.postMessage(message);
        } else {
            this.queue.push(message);
        }
    }

    private readonly hub = new HubClient();

    /** Project-local mirror of this session's tasks (in .vscode, versionable). */
    private taskMirrorFile(): string | undefined {
        const cwd = this.controller?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return cwd ? path.join(cwd, ".vscode", "symposium.tasks.json") : undefined;
    }

    /**
     * Loads the Sufficit-memory tasks bound to THIS chat session (task-anchor +
     * task-checkpoint, tagged with the session id) and pushes them to the Tasks
     * panel. Mirrored to .vscode/symposium.tasks.json so it shows offline / when
     * the hub is down. The session id is the binding key.
     */
    private async refreshTasks(): Promise<void> {
        const sessionId = this.controller?.sessionId ?? "";
        const mirror = this.taskMirrorFile();
        let items: TaskItem[] = [];
        try {
            if (!this.hub.configured() || !sessionId) { throw new Error("no hub/session"); }
            items = await fetchSessionTasks(this.hub, sessionId);
            if (mirror) {
                try {
                    fs.mkdirSync(path.dirname(mirror), { recursive: true });
                    fs.writeFileSync(mirror, JSON.stringify({ sessionId, items }, null, 2), "utf8");
                } catch { /* mirror best-effort */ }
            }
        } catch {
            // Offline / hub down: read the project-local mirror for this session.
            try {
                const cached = JSON.parse(fs.readFileSync(mirror ?? "", "utf8"));
                items = cached?.sessionId === sessionId ? (cached.items ?? []) : [];
            } catch { items = []; }
        }
        this.post({ type: "tasks", items, project: sessionId });
    }

    /**
     * Opens an inspection view as a read-only editor tab: the compact model
     * context (the per-backend store = exactly what the LLM receives now) or the
     * literal last request body (ledger/request-last.json). The on-screen chat
     * stays the full transcript; these are for analysis of the compacted side.
     */
    private async openInspectView(target: "context" | "request"): Promise<void> {
        const id = this.controller?.sessionId;
        if (!id) { void vscode.window.showInformationMessage("Open and use a session first."); return; }
        let file: string | undefined;
        if (target === "request") {
            file = path.join(ledgerDir(id), "request-last.json");
        } else {
            const root = path.join(os.homedir(), ".symposium", "sessions");
            try {
                for (const backend of fs.readdirSync(root)) {
                    const f = path.join(root, backend, id + ".json");
                    if (fs.existsSync(f)) { file = f; break; }
                }
            } catch { /* no store */ }
        }
        if (!file || !fs.existsSync(file)) {
            void vscode.window.showInformationMessage(
                "Nothing to inspect yet — send a message first (Sufficit AI / OpenAI backend only).");
            return;
        }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: false });
    }

    /** Pushes the session's user guardrails to the panel. */
    private async refreshGuardrails(): Promise<void> {
        const sessionId = this.controller?.sessionId ?? "";
        let items: { id: string; text: string }[] = [];
        try {
            if (this.hub.configured() && sessionId) {
                items = (await fetchSessionGuardrails(this.hub, sessionId)).map((g) => ({ id: g.id, text: g.text }));
            }
        } catch { items = []; }
        this.post({ type: "guardrails", items });
    }

    /**
     * Attaches the content of a VS Code integrated-browser page as a context
     * file. Invokes the built-in open_browser_page tool (prompts the user to
     * share the open page), captures its snapshot, and adds it as a composer chip.
     */
    private async attachBrowserPage(): Promise<void> {
        const lm = (vscode as unknown as { lm?: { invokeTool?: (n: string, o: unknown, t: unknown) => Promise<{ content: unknown[] }> } }).lm;
        if (!lm?.invokeTool) {
            void vscode.window.showWarningMessage("VS Code does not expose browser tools (open_browser_page) in this version.");
            return;
        }
        const cts = new vscode.CancellationTokenSource();
        try {
            const r = await lm.invokeTool("open_browser_page",
                { input: {}, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<object>, cts.token);
            const text = (r.content as any[]).map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : "")).join("\n").trim();
            if (!text || /opted not to share|no .*page/i.test(text)) {
                void vscode.window.showInformationMessage("No browser page shared.");
                return;
            }
            const dir = path.join(os.homedir(), ".symposium", "context");
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `browser-page-${Date.now()}.md`);
            fs.writeFileSync(file, "# Browser page (VS Code)\n\n" + text, "utf8");
            this.post({ type: "attachments-picked", files: [{ path: file, name: "browser-page.md" }] });
        } catch (err) {
            void vscode.window.showErrorMessage(`Failed to attach the page: ${err instanceof Error ? err.message : err}`);
        } finally {
            cts.dispose();
        }
    }

    private async onMessage(message: WebviewToHost): Promise<void> {
        symposiumLog(`[surface] <- webview: ${message?.type}${message?.type === "send" ? ` (${(message.text ?? "").length} chars)` : ""}`);
        try {
            switch (message?.type) {
                case "ready": {
                    this.ready = true;
                    void this.webview.postMessage({ type: "boot", id: "host", label: "Extension host connected", status: "ok" });
                    for (const queued of this.queue) {
                        void this.webview.postMessage(queued);
                    }
                    this.queue = [];
                    void this.refreshSessions();
                    void this.pushAccount();
                    void this.refreshTasks();
                    void this.refreshGuardrails();
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
                case "set-tools": {
                    if (Array.isArray(message.tools)) {
                        this.controller?.setAiTools(message.tools.map((t: unknown) => String(t)));
                    }
                    return;
                }
                case "attach-browser-page": {
                    await this.attachBrowserPage();
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
                case "drop-file": {
                    const file = await writeDroppedFile(message.name, message.mime, message.data ?? "");
                    if (file) {
                        this.post({ type: "attachments-picked", files: [file] });
                    }
                    return;
                }
                case "drop-files": {
                    const payloads = Array.isArray(message.files) ? message.files : [];
                    const written = await Promise.all(
                        payloads.map((f: { name?: string; mime?: string; data?: string }) =>
                            writeDroppedFile(f?.name, f?.mime, f?.data ?? "")),
                    );
                    const files = written.filter((f: { path: string; name: string } | undefined): f is { path: string; name: string } => Boolean(f));
                    if (files.length) {
                        this.post({ type: "attachments-picked", files });
                    }
                    return;
                }
                case "drop-uris": {
                    const files = Array.isArray(message.uris)
                        ? message.uris.map((u: string) => attachmentFromUri(u)).filter((f: { path: string; name: string } | undefined): f is { path: string; name: string } => Boolean(f))
                        : [];
                    if (files.length) {
                        this.post({ type: "attachments-picked", files });
                    }
                    return;
                }
                case "refresh-tasks": {
                    void this.refreshTasks();
                    return;
                }
                case "task-set-done": {
                    if (typeof message.id === "string" && this.hub.configured()) {
                        await setTaskDone(this.hub, message.id, message.done === true);
                        void this.refreshTasks();
                    }
                    return;
                }
                case "remove-guardrail": {
                    if (typeof message.id === "string" && this.hub.configured()) {
                        await removeGuardrail(this.hub, message.id);
                        await this.controller?.reloadGuardrails();
                        void this.refreshGuardrails();
                    }
                    return;
                }
                case "clear-guardrails": {
                    const sid = this.controller?.sessionId;
                    if (sid && this.hub.configured()) {
                        const ok = await vscode.window.showWarningMessage("Clear all guardrails for this session?", { modal: true }, "Clear");
                        if (ok === "Clear") {
                            await clearSessionGuardrails(this.hub, sid);
                            await this.controller?.reloadGuardrails();
                            void this.refreshGuardrails();
                        }
                    }
                    return;
                }
                case "recheck-shell-tools": {
                    // Re-probe rtk (e.g. after the user installed it); the result
                    // gates the RTK preamble on the next turn.
                    const cwd = this.controller?.cwd ?? process.cwd();
                    void probeRtk(cwd, true).then((ok) => {
                        this.post({ type: "toast", text: ok ? "rtk found — compact output enabled" : "rtk not found — using plain shell tools" });
                    });
                    return;
                }
                case "refresh-models": {
                    // Re-run remote model discovery for the current dialogue's
                    // backend (e.g. after logging in, so GET /models stops 401ing).
                    const current = this.controller?.backend ?? this.terminalSession?.backend;
                    const adapter = current ? this.deps.adapterByBackend.get(current) : undefined;
                    if (adapter) {
                        this.refreshModels(adapter, true);   // explicit: force a fresh GET /models
                    }
                    return;
                }
                case "pin-model": {
                    const pinBackend = this.controller?.backend ?? this.terminalSession?.backend;
                    if (pinBackend && typeof message.model === "string") {
                        const pinned = this.deps.modelPrefs.getPinned(pinBackend);
                        const idx = pinned.indexOf(message.model);
                        if (idx >= 0) { pinned.splice(idx, 1); } else { pinned.push(message.model); }
                        this.deps.modelPrefs.setPinned(pinBackend, pinned);
                        this.post({ type: "model-prefs", pinnedModels: pinned });
                    }
                    return;
                }
                case "set-model-default": {
                    const defBackend = this.controller?.backend ?? this.terminalSession?.backend;
                    if (defBackend && typeof message.model === "string") {
                        const defModel = message.model || undefined;
                        await this.deps.modelPrefs.setDefault(defBackend, defModel);
                        this.post({ type: "model-prefs", modelDefault: message.model });
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
                        name: adapter.displayName ?? adapter.backend,
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
                            await this.handoff.fromTerminal(message.backend);
                        } else {
                            this.handoff.switch(message.backend);
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
                case "inspect": {
                    await this.openInspectView(message.target);
                    return;
                }
                case "open-file": {
                    if (typeof message.path === "string") {
                        // vscode.open handles text AND binary (images open in the
                        // image preview), unlike openTextDocument.
                        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(message.path), { preview: true });
                    }
                    return;
                }
                case "reorder-pinned": {
                    await vscode.commands.executeCommand("symposium.reorderPinned", message.ids ?? []);
                    return;
                }
                case "file-diff": {
                    await this.changedFiles.openDiff(message.path);
                    return;
                }
                case "file-approve": {
                    if (typeof message.path === "string") {
                        await this.changedFiles.approve(message.path);
                        this.changedFiles.refreshNow();
                    }
                    return;
                }
                case "file-reject": {
                    if (typeof message.path === "string") {
                        if (await this.changedFiles.reject(message.path)) { this.controller?.resolveChanged(message.path); }
                        else { void vscode.window.showWarningMessage("Could not revert " + message.path); }
                    }
                    return;
                }
                case "file-approve-all": {
                    for (const p of this.controller?.changedPaths() ?? []) {
                        await this.changedFiles.approve(p);
                    }
                    this.changedFiles.refreshNow();
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
                        if (await this.changedFiles.reject(p)) { this.controller?.resolveChanged(p); }
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
                        name: adapter.displayName ?? adapter.backend,
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
                        await this.handoff.forSession(
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
            // Only a "send" drives the agent's turn. Any other message is a UI
            // command (open-file, file-diff, etc.); a failure there is local and
            // must NOT be treated as a turn-ending (fatal) error, otherwise it
            // would flip the composer's send/stop button as if the agent stopped.
            const fatal = message?.type === "send";
            void this.webview.postMessage({
                type: "event",
                event: { kind: "error", message: error instanceof Error ? error.message : String(error), fatal },
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
            // Time-bound: a backend's listSessions() (e.g. HTTP model discovery)
            // can hang on code-server with no network/auth; never let it block
            // startup and trap the UI on the boot screen.
            const sessions = await Promise.race([
                this.deps.listSessions().catch(() => [] as SessionInfo[]),
                new Promise<SessionInfo[]>((resolve) => setTimeout(() => resolve([]), 6000)),
            ]);
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
            void this.webview.postMessage({ type: "boot", id: "session", label: "No backend available", status: "fail", detail: "configure an adapter" });
            void this.webview.postMessage({ type: "boot", complete: true });
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

    /**
     * Hands a TERMINAL session off to another backend. A terminal session has
     * no in-memory ChatController transcript (the CLI owns the conversation),
     * so the prior exchange is read back from the CLI's stored transcript via
     * the adapter's `history()`. The handoff then opens a regular chat dialogue
     * on the target backend seeded with that conversation. The original
     * terminal keeps running (it is only detached), so it can be reopened.
     */

    /**
     * Collapses adapter HistoryMessages down to plain user/assistant rows for a
     * handoff replay — tool rows are dropped (only the human-readable dialogue
     * is carried over), and consecutive same-role rows are kept as-is.
     */

    /**
     * Hands a STORED session (picked from the sessions list's right-click menu)
     * off to another backend. The session need not be the one open in this
     * surface: its prior exchange is read back from the source backend's stored
     * transcript via `history()`, then a fresh dialogue is opened on the target
     * backend in this surface, seeded with that conversation. The original
     * session is untouched (it stays stored and can still be resumed).
     */

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
            backendName: adapter.displayName,
            modelLabels: adapter.modelLabels?.() ?? {},
            resumed: true,
            readOnly: true,
            models: [],
            sessionId: info.sessionId,
            title: info.title,
            sessionsSide,
            chatOnly: this.chatOnly,
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", "queue"),
            execDisplay: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
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
        // The followed process has no local controller, so its working/idle is
        // inferred from the transcript and published to the runtime, which the
        // sessions list reads via statusFor — same indicator as live sessions.
        this.followedSessionId = info.sessionId;
        this.followHandle.onStatus?.((status) => {
            this.deps.runtime.setFollowStatus(info.sessionId, status);
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
            backendName: adapter.displayName,
            modelLabels: adapter.modelLabels?.() ?? {},
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
            activeFileStartColumn: activeEditorContext().startColumn,
            activeFileEndColumn: activeEditorContext().endColumn,
            activeFilePreview: activeEditorContext().preview,
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", "queue"),
            execDisplay: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
        });
        this.terminalSession = new TerminalSession(
            adapter,
            { cwd: options.cwd, resumeSessionId: options.resumeSessionId, model: options.model, reasoning: options.reasoning, env: options.env, tmuxName: options.tmuxName },
            (message) => this.post(message),
            symposiumLog,
            (sessionId, status) => this.deps.runtime.setFollowStatus(sessionId, status),
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

        // New (non-resumed) sessions: inject the language hint and the
        // per-workspace bootstrap (standing Sufficit context) before the first
        // message. The bootstrap link is surfaced on the empty screen so the user
        // can read its source file. Resumed sessions already carry their context.
        let bootstrapLink: { path: string; name: string } | undefined;
        if (!options.resumeSessionId) {
            const langHint = this.buildLangHint();
            if (langHint) {
                options = { ...options, systemPrompt: options.systemPrompt ? options.systemPrompt + "\n\n" + langHint : langHint };
            }
            const boot = readWorkspaceBootstrap(options.cwd);
            if (boot) {
                options = { ...options, bootstrap: boot.text };
                bootstrapLink = { path: boot.path, name: boot.name };
            }
        }

        // Reuse a still-running controller for this session; else create one.
        const existing = options.resumeSessionId
            ? this.deps.runtime.findBySessionId(options.resumeSessionId)
            : undefined;
        const controller = existing ?? this.deps.runtime.create(adapter, options);
        this.controller = controller;
        void this.refreshTasks();   // load this session's tasks into the panel
        void this.refreshGuardrails();

        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.post({
            type: "meta",
            backend: adapter.backend,
            backendName: adapter.displayName,
            modelLabels: adapter.modelLabels?.() ?? {},
            // Inline badge for an agent-def-bound dialogue (shown once, on the
            // first turn). Null for plain sessions. See SessionStartOptions.
            agentLabels: options.agentName
                ? { agent: options.agentName, toolsDeclared: options.toolsDeclared ?? [], toolsAllowed: options.toolsAllowed ?? [] }
                : null,
            // Per-workspace bootstrap link for the empty screen (null = none).
            bootstrapLink: bootstrapLink ?? null,
            resumed: !!options.resumeSessionId,
            models: adapter.models?.() ?? [],
            reasoningLevels: adapter.reasoningLevels?.() ?? [],
            reasoningDefault: vscode.workspace.getConfiguration("symposium." + adapter.backend).get<string>("reasoning", "default"),
            modelDefault: vscode.workspace.getConfiguration("symposium." + adapter.backend).get<string>("model", ""),
            pinnedModels: this.deps.modelPrefs.getPinned(adapter.backend),
            // Last model used in this session (resume), so the picker restores it
            // instead of defaulting to the first discovered model.
            sessionModel: info?.model ?? "",
            // Attach-browser-page button only shows when a Simple Browser is open.
            browserOpen: isSimpleBrowserOpen(),
            // Per-session tool gating for the native AI backend (undefined for CLIs).
            aiTools: controller.aiToolsInfo?.(),
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
            activeFileStartColumn: activeEditorContext().startColumn,
            activeFileEndColumn: activeEditorContext().endColumn,
            activeFilePreview: activeEditorContext().preview,
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", "queue"),
            execDisplay: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
        });
        controller.attach((message) => {
            // The controller emits the RAW edited-files set; the surface filters
            // it against live git status (so staged files drop, unstaging them
            // brings them back) before showing it.
            if ((message as any)?.type === "changed-files") {
                void this.changedFiles.refresh((message as any).items);
                return;
            }
            // Capture a freshly-assigned session id so a brand-new dialogue
            // also becomes the restorable "last active" one.
            const ev = (message as any)?.event;
            if (ev?.kind === "session" && ev.sessionId) {
                this.deps.lastActive.set({ backend, sessionId: ev.sessionId });
            }
            // Repaint the affected panel the moment a session-mutating tool finishes,
            // so an agent-added guardrail / task shows immediately instead of only at
            // turn-end. (A short retry covers the hub search index settling.)
            if (ev?.kind === "tool-end" && typeof ev.toolName === "string") {
                const n = ev.toolName;
                if (n === "add_guardrail" || n === "clear_guardrails") {
                    const repaint = () => void this.controller?.reloadGuardrails().then(() => this.refreshGuardrails());
                    repaint(); setTimeout(repaint, 700);
                } else if (n === "add_task" || n === "task_complete" || (n === "memory_save")) {
                    void this.refreshTasks(); setTimeout(() => void this.refreshTasks(), 700);
                }
            }
            // Refresh the Tasks panel when a turn ends: the agent may have saved
            // task-checkpoints mid-turn (bound to this session), which the panel
            // otherwise wouldn't pick up until reopen/manual refresh.
            if (ev?.kind === "turn-end") {
                void this.refreshTasks();
                // The agent may have added a guardrail mid-turn (add_guardrail tool):
                // reload the controller's injection cache and repaint the panel.
                void this.controller?.reloadGuardrails().then(() => this.refreshGuardrails());
                // Re-mirror the working tree from git: a turn may have edited files
                // via shell/sed (no tool event, no index change) that the live
                // changed-files signal and the .git/index watcher both miss.
                this.changedFiles.refreshNow();
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

    /** Symposium-level slash commands injected into every backend's autocomplete. */
    private readonly symposiumCommands: import("../adapters/types").SlashCommand[] = [
        { name: "refresh-models", description: "Refresh the model list from the provider API", kind: "builtin" },
    ];

    /** Fetches the backend's slash commands/skills and sends them for autocomplete. */
    private postCommands(adapter: AgentAdapter): void {
        const append = this.symposiumCommands;
        if (!adapter.commands) {
            this.post({ type: "commands", items: append });
            return;
        }
        void adapter.commands()
            .then((items) => this.post({ type: "commands", items: [...items, ...append] }))
            .catch(() => this.post({ type: "commands", items: append }));
    }

    /**
     * The `meta` message carries `adapter.models()` synchronously, which for
     * remote-discovery backends (OpenAI-compatible) may be a stale/fallback
     * list when the discovery cache is still empty — e.g. the first session
     * opened after a reload. This kicks off an async refresh and posts an
     * updated `models` message so the picker repopulates once discovery lands.
     */
    private refreshModels(adapter: AgentAdapter, force = false): void {
        if (!adapter.refreshModels) {
            return;
        }
        const backend = adapter.backend;
        // Explicit refresh (force) must re-query the gateway, not return the
        // possibly-stale file cache; the post-meta auto-refresh stays cache-friendly.
        void adapter.refreshModels(force)
            .then(({ models, labels }) => {
                // Only the dialogue still bound to this backend should apply it
                // (the user may have switched agents while discovery ran).
                const current = this.controller?.backend ?? this.terminalSession?.backend;
                if (current !== backend || !models?.length) {
                    return;
                }
                this.post({ type: "models", models, labels: labels ?? {}, refreshed: force });
            })
            .catch(() => undefined);
    }

    /** Pushes the Sufficit account (or null) for the sessions-pane footer. */
    private async pushAccount(): Promise<void> {
        if (!this.deps.account) {
            return;
        }
        const profile = await this.deps.account.get().catch(() => undefined);
        this.loggedIn = !!profile;
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
    private buildLangHint(): string {
        const cfg = vscode.workspace.getConfiguration("symposium.chat");
        const hints: string[] = [];

        // 1) Language preference.
        const setting = cfg.get<string>("preferredLanguage", "").trim();
        const lang = setting || vscode.env.language || "";
        if (lang && !/^en(-|$)/i.test(lang)) {
            hints.push(`The user prefers responses in "${lang}". This is a preference, not a strict requirement — use your best judgment.`);
        }

        // 2) User's manual system instruction (free text), when provided.
        const custom = cfg.get<string>("systemInstruction", "").trim();
        if (custom) {
            hints.push(custom);
        }

        // 3) Logged-in users: never claim ignorance before consulting memory.
        if (this.loggedIn) {
            hints.push(
                "Before telling the user you don't know or lack enough information, you MUST first search the Sufficit shared memory " +
                "(use the memory_search tool, then memory_get_observations for promising hits). Only after that search comes up empty " +
                "may you say you don't know — and mention that you checked the Sufficit memory.");
        }

        return hints.join("\n\n");
    }

    /** Tears down an active transcript follow and drops its inferred status. */
    private detachFollow(): void {
        this.followHandle?.dispose();
        this.followHandle = undefined;
        if (this.followedSessionId) {
            this.deps.runtime.clearFollowStatus(this.followedSessionId);
            this.followedSessionId = undefined;
        }
    }

    private detachActive(): void {
        this.controller?.detach();
        this.controller = undefined;
        this.detachTerminal();
        this.detachFollow();
    }

    /** Disposes the terminal session and drops its inferred follow status. */
    private detachTerminal(): void {
        const tid = this.terminalSession?.currentSessionId;
        this.terminalSession?.dispose();
        this.terminalSession = undefined;
        if (tid) { this.deps.runtime.clearFollowStatus(tid); }
    }

    /**
     * The session shown here was deleted elsewhere: if it's the one currently
     * open, tear the binding down and fall back to another session (or the empty
     * state) so a deleted session can't stay open in the conversation pane.
     */
    sessionDeleted(sessionId: string): void {
        if (this.sid() !== sessionId) { return; }
        // The runtime already disposed the controller on delete; just drop refs.
        this.controller = undefined;
        this.detachTerminal();
        this.detachFollow();
        // Clear the pane to the empty state — do NOT auto-start a new dialogue
        // (that spawned a stray live "New session" on every delete). The next
        // send (or picking a session) starts one.
        this.post({ type: "clear" });
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

    /**
     * Filters the controller's raw edited-files set against live git status and
     * pushes the result to the webview. Also (re)arms a watcher on the repos'
     * index so staging/unstaging in git or the SCM view syncs back here.
     */

    /** Recomputes the displayed set from the controller's current raw set. */

    /** Watches workspace git indexes so external stage/unstage re-syncs the list. */

    /**
     * Reverts a file to its pre-edit state. Prefers the session snapshot (works
     * with or without git, even for new files); falls back to git restore for
     * resumed sessions that have no snapshot.
     */

    /**
     * Diffs an edited file against its baseline: the session snapshot if we have
     * one, else the git HEAD version. New files with no baseline just open.
     */

    dispose(): void {
        // Detach only — the runtime owns controller lifetimes so sessions
        // survive the view/panel being closed.
        this.detachActive();
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
    }
}
