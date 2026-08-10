import * as vscode from "vscode";
import { AgentAdapter, FollowHandle, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "../application/chatController";
import { WebviewToHost, AgentPickerEntry } from "../protocol/chat";
import { renderHtml } from "./chatHtml";
import { TerminalSession } from "./terminalSession";
import { symposiumLog } from "../extension/log";
import { ChangedFilesManager } from "./changedFiles";
import { BackendHandoff } from "./backendHandoff";
import { SurfaceSync } from "./surfaceSync";
import { SurfaceDialogues } from "./surfaceDialogues";
import { SurfaceMessages } from "./surfaceMessages";
import { HubClient } from "../sync/hubClient";
import { pushVoicePreferences } from "./voicePreferences";
import type { ChatSurfaceDeps } from "./chatSurfaceTypes";
import { registerChatSurfaceListeners } from "./chatSurfaceListeners";
import { buildSurfaceLanguageHint, resolveSurfaceLanguage } from "./chatSurfaceLanguage";
import { SurfaceQuota } from "./surfaceQuota";
import { AhpMessagePortTransport } from "../ahp/messagePortTransport";
import { createSurfaceAhpPort } from "./surfaceAhp";

export type { ChatSurfaceDeps } from "./chatSurfaceTypes";

/** Wires one sidebar/editor webview to the shared chat machinery. */
export class ChatSurface {
    private controller: ChatController | undefined;
    private controllerDetach: (() => void) | undefined;
    private terminalSession: TerminalSession | undefined;
    private followHandle: FollowHandle | undefined;
    private followedSessionId: string | undefined;
    private sendBlockedReason: SessionInfo["continuationBlockedReason"] | "live-follow" | undefined;
    private ready = false;
    private loggedIn = false; // cached Sufficit login state (for system hints)
    private queue: unknown[] = [];
    private readonly hub = new HubClient();
    private readonly quota = new SurfaceQuota({
        post: (message) => this.post(message),
        getModel: () => this.controller?.getModel() || undefined,
    });

    private readonly disposables: vscode.Disposable[] = [];
    private readonly ahpPort: AhpMessagePortTransport | undefined;
    private readonly changedFiles = new ChangedFilesManager(
        {
            post: (m) => this.post(m),
            getCwd: () => this.cwd(),
            getSid: () => this.sid(),
            resolveChanged: (p) => this.controller?.resolveChanged(p),
            getRawItems: () => this.controller?.changedItemsRaw() ?? [],
        },
        this.disposables,
    );
    private readonly handoff = new BackendHandoff({
        getAdapter: (b) => this.deps.adapterByBackend.get(b),
        listSessions: () => this.deps.listSessions(),
        cwdFor: (i) => this.deps.cwdFor(i),
        openDialogue: (b, o, t) => this.openDialogue(b, o, t),
        post: (m) => this.post(m),
        getController: () => this.controller,
        getTerminalSession: () => this.terminalSession,
        getStore: () => this.deps.store,
    });
    private readonly sync = new SurfaceSync({
        post: (m) => this.post(m),
        getController: () => this.controller,
        getTerminalSession: () => this.terminalSession,
        getAccount: () => this.deps.account,
        setLoggedIn: (v) => {
            this.loggedIn = v;
        },
        getCommands: () => this.symposiumCommands,
    });
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
        this.ahpPort = createSurfaceAhpPort(
            this.deps,
            (message) => this.post(message),
            this.onSessionCreated,
        );
        this.dialogues = new SurfaceDialogues({
            deps: this.deps,
            chatOnly: this.chatOnly,
            webview: this.webview,
            post: (m) => this.post(m),
            getController: () => this.controller,
            setController: (c) => {
                this.controller = c;
            },
            setControllerDetach: (detach) => {
                this.controllerDetach = detach;
            },
            bindAhp: this.ahpPort
                ? (backend, controller) => {
                      const sessionId = controller.sessionKey ?? controller.sessionId;
                      return sessionId ? this.ahpPort?.bind(backend, sessionId) : undefined;
                  }
                : undefined,
            onSessionCreated: (sessionId) => this.onSessionCreated?.(sessionId),
            setTerminalSession: (t) => {
                this.terminalSession = t;
            },
            setFollowHandle: (h) => {
                this.followHandle = h;
            },
            setFollowedSessionId: (id) => {
                this.followedSessionId = id;
            },
            setSendBlockedReason: (reason) => {
                this.sendBlockedReason = reason;
            },
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
            chatOnly: this.chatOnly,
            post: (m) => this.post(m),
            markReady: () => this.markReady(),
            refreshSessions: () => this.refreshSessions(),
            refreshQuotas: (force) => this.quota.refresh(force),
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
            ahp: this.ahpPort,
        });
        webview.options = { enableScripts: true };
        const version = (
            vscode.extensions.getExtension("sufficit.sufficit-vscode-symposium")?.packageJSON as
                | { version?: string }
                | undefined
        )?.version;
        webview.html = renderHtml(version);
        webview.onDidReceiveMessage((message) => void this.onMessage(message));
        registerChatSurfaceListeners({
            deps: this.deps,
            disposables: this.disposables,
            chatOnly: this.chatOnly,
            isReady: () => this.ready,
            post: (message) => this.post(message),
            pushAccount: () => void this.sync.pushAccount(),
            pushVoicePreferences: () => this.pushVoicePreferences(),
        });
    }

    /** Focuses the chat composer without replacing its current draft. */
    focusInput(): void {
        this.post({ type: "focus-input" });
    }

    private post(message: unknown): void {
        if (!this.ready) {
            this.queue.push(message);
            return;
        }
        void Promise.resolve(this.webview.postMessage(message)).then(
            (delivered) => {
                if (!delivered) {
                    symposiumLog("[surface] webview rejected a message");
                }
            },
            (error) => {
                symposiumLog(
                    `[surface] webview post failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            },
        );
    }

    private onMessage(message: WebviewToHost): Promise<void> {
        return this.messages.handle(message);
    }

    /** Marks the webview ready: flushes posts queued before the script went live. */
    private markReady(): void {
        this.ready = true;
        void this.webview.postMessage({
            type: "boot",
            id: "host",
            label: "Extension host connected",
            status: "ok",
        });
        // Localize the webview UI: same precedence as the AI language hint.
        void this.webview.postMessage({ type: "setLang", lang: resolveSurfaceLanguage() });

        this.pushVoicePreferences();
        const openIn = vscode.workspace
            .getConfiguration("symposium.chat")
            .get<string>("openIn", "editor");
        this.post({ type: "prefs", openIn, sessionsOnly: !this.chatOnly && openIn === "editor" });

        for (const queued of this.queue) {
            void this.webview.postMessage(queued);
        }
        this.queue = [];
        this.quota.startAutoRefresh();
    }

    private activateUsage(adapter: AgentAdapter): void {
        this.quota.activate(adapter);
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
    openSession(info: SessionInfo): void {
        this.dialogues.openSession(info);
    }
    followSession(info: SessionInfo): Promise<void> {
        return this.dialogues.followSession(info);
    }
    openDialogue(
        backend: string,
        options: SessionStartOptions,
        title: string,
        info?: SessionInfo,
    ): void {
        this.dialogues.openDialogue(backend, options, title, info);
    }
    openTerminalDialogue(
        backend: string,
        options: SessionStartOptions & {
            env?: Record<string, string>;
            tmuxName?: string;
            reasoning?: string;
        },
        title: string,
    ): void {
        this.dialogues.openTerminalDialogue(backend, options, title);
    }

    /** Renders the in-chat agent picker; selection returns as `pick-agent`. */
    showAgentPicker(agents: AgentPickerEntry[]): void {
        this.post({ type: "agent-picker", agents });
    }
    /** Refreshes probe results without reopening a picker the user already left. */
    refreshAgentPicker(agents: AgentPickerEntry[]): void {
        this.post({ type: "agent-picker-update", agents });
    }

    /** Symposium-level slash commands injected into every backend's autocomplete. */
    private readonly symposiumCommands: import("../adapters/types").SlashCommand[] = [
        {
            name: "refresh-models",
            description: "Refresh the model list from the provider API",
            kind: "builtin",
        },
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
        const controller = this.controller;
        if (!controller?.sessionId) {
            return;
        }
        // Read the decorated title (includes custom renames) from the session list.
        try {
            const sessions = await this.deps.listSessions();
            const info = sessions.find((s) => s.sessionId === controller.sessionId);
            const title = info?.title ?? controller?.title ?? "";
            this.post({ type: "title-update", title });
        } catch {
            this.post({ type: "title-update", title: controller?.title ?? "" });
        }
    }

    /**
     * Unbinds the current dialogue from this surface WITHOUT stopping it: the
     * headless controller keeps running in the shared runtime (re-attached on
     * return). The terminal/follow mirrors are surface-bound and torn down
     * (the terminal panel itself stays open).
     */
    private buildLangHint(): string {
        return buildSurfaceLanguageHint(this.loggedIn);
    }

    /** Tears down the view follow while preserving the last live status. */
    private detachFollow(): void {
        this.followHandle?.dispose();
        this.followHandle = undefined;
        if (this.followedSessionId) {
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

    /** Detaches the terminal mirror; the terminal process itself keeps running. */
    private detachTerminal(): void {
        this.terminalSession?.dispose();
        this.terminalSession = undefined;
    }

    /** Close the active pane when its session is deleted elsewhere. */
    sessionDeleted(sessionId: string): void {
        if (this.activeSessionId() !== sessionId) {
            return;
        }
        // Deletion is the one lifecycle transition that must remove the
        // last-known follow status; a normal section switch must preserve it.
        this.deps.runtime.clearFollowStatus(sessionId);
        // Detach surface-bound mirrors before runtime disposal.
        this.detachActive();
        // Clear the pane to the empty state — do NOT auto-start a new dialogue
        // (that spawned a stray live "New session" on every delete). The next
        // send (or picking a session) starts one.
        this.post({ type: "clear" });
    }

    /** Working directory of the active session (for git operations). */
    private cwd(): string {
        return (
            this.controller?.cwd ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
            process.cwd()
        );
    }

    /** Active session id (snapshots are keyed by it). */
    private sid(): string {
        return this.controller?.sessionKey ?? this.controller?.sessionId ?? "";
    }

    /** Exact session currently rendered by this surface, including mirrors. */
    private activeSessionId(): string {
        return this.sid() || this.terminalSession?.currentSessionId || this.followedSessionId || "";
    }

    dispose(): void {
        // Detach only — the runtime owns controller lifetimes so sessions
        // survive the view/panel being closed.
        this.detachActive();
        this.quota.dispose();
        this.ahpPort?.dispose();
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
    }
}
