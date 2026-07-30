import * as vscode from "vscode";
import { AdapterUsageProvider, AgentAdapter, FollowHandle, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { WebviewToHost, AgentPickerEntry } from "./protocol";
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
import { pushVoicePreferences } from "./voicePreferences";

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
        get(force?: boolean): Promise<{ name?: string; email?: string; picture?: string } | undefined>;
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
        setLineage(sessionId: string, lineageId: string | undefined): void;
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
    private controllerDetach: (() => void) | undefined;
    private terminalSession: TerminalSession | undefined;
    private followHandle: FollowHandle | undefined;
    private followedSessionId: string | undefined;
    private sendBlockedReason: SessionInfo["continuationBlockedReason"] | "live-follow" | undefined;
    private ready = false;
    private loggedIn = false;   // cached Sufficit login state (for system hints)
    private queue: unknown[] = [];
    private activeUsage: AdapterUsageProvider | undefined;
    private quotaGeneration = 0;
    private quotaRefreshTimer: ReturnType<typeof setInterval> | undefined;
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
        private readonly onSessionCreated?: (sessionId: string) => void,
        // Restores this exact webview after a host command temporarily moves
        // workbench focus away (notably VS Code's editor-dictation command).
        private readonly reveal?: () => void | Thenable<void>,
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
            setControllerDetach: (detach) => { this.controllerDetach = detach; },
            onSessionCreated: (sessionId) => this.onSessionCreated?.(sessionId),
            setTerminalSession: (t) => { this.terminalSession = t; },
            setFollowHandle: (h) => { this.followHandle = h; },
            setFollowedSessionId: (id) => { this.followedSessionId = id; },
            setSendBlockedReason: (reason) => { this.sendBlockedReason = reason; },
            activateUsage: (adapter) => this.activateUsage(adapter),
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
            refreshQuotas: (force) => this.refreshQuotas(force),
            openSession: (info) => this.openSession(info),
            restoreFocus: async () => {
                await this.reveal?.();
                this.focusInput();
            },
            getController: () => this.controller,
            getTerminalSession: () => this.terminalSession,
            getFollowHandle: () => this.followHandle,
            getSendBlockedReason: () => this.sendBlockedReason,
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
        // Live-apply preference changes (e.g. sessions side, voice settings)
        // without a reload — so a change made in the Config panel is testable
        // immediately on an already-open chat surface.
        this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("symposium.chat.sessionsSide")) {
                this.post({ type: "prefs", sessionsSide: vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto") });
            }
            if (e.affectsConfiguration("symposium.chat.devMode")) {
                this.post({ type: "prefs", devMode: vscode.workspace.getConfiguration("symposium.chat").get<boolean>("devMode", false) });
            }
            if (e.affectsConfiguration("symposium.voice") && this.ready) {
                this.pushVoicePreferences();
            }
        }));
        this.disposables.push(vscode.extensions.onDidChange(() => {
            if (this.ready) { this.pushVoicePreferences(); }
        }));
    }

    /** Focuses the chat composer without replacing its current draft. */
    focusInput(): void {
        this.post({ type: "focus-input" });
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

        this.pushVoicePreferences();

        for (const queued of this.queue) {
            void this.webview.postMessage(queued);
        }
        this.queue = [];
        this.quotaRefreshTimer ??= setInterval(() => void this.refreshQuotas(), 60_000);
    }

    private activateUsage(adapter: AgentAdapter): void {
        this.activeUsage = adapter.usage;
        this.quotaGeneration++;
        void this.refreshQuotas();
    }

    private async refreshQuotas(force = false): Promise<void> {
        const usage = this.activeUsage;
        if (!usage) { return; }
        const generation = this.quotaGeneration;
        this.post({ type: "quota-loading", loading: true });
        try {
            const snapshot = await usage.read(force);
            if (generation !== this.quotaGeneration || usage !== this.activeUsage) { return; }
            this.post({ type: "event", event: { kind: "quota", ...snapshot } });
            this.post({ type: "quota-loading", loading: false, backend: usage.backend });
        } catch (error) {
            if (generation !== this.quotaGeneration || usage !== this.activeUsage) { return; }
            symposiumLog(`[quota] Failed to read local adapter usage: ${error instanceof Error ? error.message : String(error)}`);
            this.post({ type: "quota-loading", loading: false, backend: usage.backend, error: true });
        }
    }

    /**
     * Sends voice preferences to the webview. `engine` + `localStt` drive the
     * hybrid mic: Web Speech in the browser, local host transcription on
     * desktop. The local path starts disabled and is enabled only after its
     * binary/model readiness check succeeds, preventing a broken setup from
     * exposing a microphone that can only fail. Called on ready, AND again on
     * every `symposium.voice.*` config change (see the listener in the
     * constructor) so a setting changed in Config takes effect immediately.
     */
    private pushVoicePreferences(): void {
        pushVoicePreferences((message) => this.post(message));
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

    /** Renders the in-chat "which agent joins the symposium?" picker (replaces
     *  the native QuickPick). Selection comes back as a `pick-agent` message. */
    showAgentPicker(agents: AgentPickerEntry[]): void {
        this.post({ type: "agent-picker", agents });
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

    /** Re-pushes the active session's title to the webview (so a rename is
     *  reflected in the chat header, not just the sessions list row). */
    async reMetaActive(): Promise<void> {
        if (!this.controller?.sessionId) { return; }
        // Read the decorated title (includes custom renames) from the session list.
        try {
            const sessions = await this.deps.listSessions();
            const info = sessions.find((s) => s.sessionId === this.controller!.sessionId);
            const title = info?.title ?? this.controller!.title;
            this.post({ type: "title-update", title });
        } catch {
            this.post({ type: "meta", title: this.controller.title });
        }
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
        this.controllerDetach?.();
        this.controllerDetach = undefined;
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
        if (this.quotaRefreshTimer) {
            clearInterval(this.quotaRefreshTimer);
            this.quotaRefreshTimer = undefined;
        }
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
    }
}
