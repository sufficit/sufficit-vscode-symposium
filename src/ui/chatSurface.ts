import * as vscode from "vscode";
import { AgentAdapter, FollowHandle, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { WebviewToHost } from "./protocol";
import { renderHtml } from "./chatHtml";
import { TerminalSession } from "./terminalSession";
import { LiveSessions } from "../sessions/runtime";
import { symposiumLog } from "../extension";
import { ChangedFilesManager } from "./changedFiles";
import { BackendHandoff } from "./backendHandoff";
import { SurfaceSync } from "./surfaceSync";
import { SurfaceDialogues } from "./surfaceDialogues";
import { SurfaceMessages } from "./surfaceMessages";
import { HubClient } from "../sync/hubClient";
import { activeEditorContext, isSimpleBrowserOpen } from "./chatSurfaceContext";
import { canUseLocalStt } from "../voice/sttRouting";

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
    /** Session metadata store (titles, archive, pin, parent relationships). */
    store: {
        setParent(sessionId: string, parentId: string | undefined): void;
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
    private readonly hub = new HubClient();

    private readonly disposables: vscode.Disposable[] = [];
    private readonly changedFiles = new ChangedFilesManager({ post: (m) => this.post(m), getCwd: () => this.cwd(), getSid: () => this.sid(), resolveChanged: (p) => this.controller?.resolveChanged(p), getRawItems: () => this.controller?.changedItemsRaw() ?? [] }, this.disposables);
    private readonly handoff = new BackendHandoff({ getAdapter: (b) => this.deps.adapterByBackend.get(b), listSessions: () => this.deps.listSessions(), cwdFor: (i) => this.deps.cwdFor(i), openDialogue: (b, o, t) => this.openDialogue(b, o, t), post: (m) => this.post(m), getController: () => this.controller, getTerminalSession: () => this.terminalSession, getStore: () => this.deps.store });
    private readonly sync = new SurfaceSync({ post: (m) => this.post(m), getController: () => this.controller, getTerminalSession: () => this.terminalSession, getAccount: () => this.deps.account, setLoggedIn: (v) => { this.loggedIn = v; }, getCommands: () => this.symposiumCommands });
    // Constructor-initialized (not field initializers): they eagerly read
    // parameter properties (deps/webview/chatOnly/onTitleChange) and the
    // field-initialized collaborators, which aren't ready until the body runs.
    private readonly dialogues: SurfaceDialogues;
    private readonly messages: SurfaceMessages;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly deps: ChatSurfaceDeps,
        private readonly onTitleChange?: (title: string) => void,
        // Editor panels show only the open conversation; the sidebar shows the
        // sessions list beside it.
        private readonly chatOnly = false,
    ) {
        this.dialogues = new SurfaceDialogues({
            deps: this.deps,
            chatOnly: this.chatOnly,
            webview: this.webview,
            post: (m) => this.post(m),
            getController: () => this.controller,
            setController: (c) => { this.controller = c; },
            setTerminalSession: (t) => { this.terminalSession = t; },
            setFollowHandle: (h) => { this.followHandle = h; },
            setFollowedSessionId: (id) => { this.followedSessionId = id; },
            detachActive: () => this.detachActive(),
            buildLangHint: () => this.buildLangHint(),
            onTitleChange: this.onTitleChange,
            sync: this.sync,
            changedFiles: this.changedFiles,
        });
        this.messages = new SurfaceMessages({
            webview: this.webview,
            deps: this.deps,
            post: (m) => this.post(m),
            markReady: () => this.markReady(),
            refreshSessions: () => this.refreshSessions(),
            openSession: (info) => this.openSession(info),
            getController: () => this.controller,
            getTerminalSession: () => this.terminalSession,
            getFollowHandle: () => this.followHandle,
            sync: this.sync,
            dialogues: this.dialogues,
            handoff: this.handoff,
            changedFiles: this.changedFiles,
            hub: this.hub,
        });
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
            this.disposables.push(this.deps.account.onDidChange(() => void this.sync.pushAccount()));
        }
        // Live-apply preference changes (e.g. sessions side) without a reload.
        this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("symposium.chat.sessionsSide")) {
                this.post({ type: "prefs", sessionsSide: vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto") });
            }
        }));
    }

    private post(message: unknown): void {
        const msg = message as Record<string, unknown> | null;
        symposiumLog(`[surface] -> webview: ${msg?.type ?? ""}${this.ready ? "" : " (queued)"}`);
        if (this.ready) {
            void this.webview.postMessage(message);
        } else {
            this.queue.push(message);
        }
    }

    private onMessage(message: WebviewToHost): Promise<void> {
        return this.messages.handle(message);
    }

    /** Marks the webview ready: flushes posts queued before the script went live. */
    private markReady(): void {
        this.ready = true;
        void this.webview.postMessage({ type: "boot", id: "host", label: "Extension host connected", status: "ok" });
        // Localize the webview UI: same precedence as the AI language hint
        // (symposium.chat.preferredLanguage, else VS Code's display language).
        const langCfg = vscode.workspace.getConfiguration("symposium.chat");
        const lang = langCfg.get<string>("preferredLanguage", "").trim() || vscode.env.language || "en";
        void this.webview.postMessage({ type: "setLang", lang });

        // Send voice preferences to webview. `engine` + `localStt` drive the
        // hybrid mic: Web Speech in the browser, local host transcription on desktop.
        const voiceCfg = vscode.workspace.getConfiguration("symposium");
        const voiceEngine = voiceCfg.get<string>("voice.engine", "auto");
        const voicePreferences = {
            language: voiceCfg.get<string>("voice.language", "pt-BR"),
            continuous: voiceCfg.get<boolean>("voice.continuous", true),
            interimResults: voiceCfg.get<boolean>("voice.interimResults", true),
            dotsAnimation: voiceCfg.get<boolean>("voice.dotsAnimation", true),
            soundFeedback: voiceCfg.get<boolean>("voice.soundFeedback", true),
            engine: voiceEngine,
            // `auto` uses browser speech in web/code-server UI and local STT on desktop.
            localStt: canUseLocalStt(voiceEngine, vscode.env.uiKind === vscode.UIKind.Web),
            // Desktop: the host records the mic natively (ffmpeg) — webview
            // getUserMedia is unreliable in VS Code (permission lost on reload).
            hostCapture: vscode.env.uiKind !== vscode.UIKind.Web,
        };
        void this.webview.postMessage({ type: "setVoicePreferences", preferences: voicePreferences });

        for (const queued of this.queue) {
            void this.webview.postMessage(queued);
        }
        this.queue = [];
    }

    // Dialogue lifecycle (open / resume / follow / terminal / branch) lives in
    // SurfaceDialogues; these public entry points are kept as thin delegators
    // for the external callers (commands, chatView, chatPanel, handoff).
    openSession(info: SessionInfo): void { this.dialogues.openSession(info); }
    followSession(info: SessionInfo): Promise<void> { return this.dialogues.followSession(info); }
    openDialogue(backend: string, options: SessionStartOptions, title: string, info?: SessionInfo): void {
        this.dialogues.openDialogue(backend, options, title, info);
    }
    openTerminalDialogue(backend: string, options: SessionStartOptions & { env?: Record<string, string>; tmuxName?: string; reasoning?: string }, title: string): void {
        this.dialogues.openTerminalDialogue(backend, options, title);
    }

    /** Symposium-level slash commands injected into every backend's autocomplete. */
    private readonly symposiumCommands: import("../adapters/types").SlashCommand[] = [
        { name: "refresh-models", description: "Refresh the model list from the provider API", kind: "builtin" },
    ];

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

        // 3) Logged-in users: search Sufficit memory before asking the user.
        if (this.loggedIn) {
            const memoryHint = vscode.workspace.getConfiguration("symposium.chat").get<string>("memoryInstruction", "").trim();
            if (memoryHint) { hints.push(memoryHint); }
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
