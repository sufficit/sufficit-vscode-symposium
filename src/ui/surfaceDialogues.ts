import * as vscode from "vscode";
import { FollowHandle, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { TerminalSession } from "./terminalSession";
import type { ChatSurfaceDeps } from "./chatSurface";
import { SurfaceSync } from "./surfaceSync";
import { ChangedFilesManager } from "./changedFiles";
import { readWorkspaceBootstrap } from "../config/root";
import { activeEditorContext, isSimpleBrowserOpen } from "./chatSurfaceContext";
import { symposiumLog } from "../extension";
import type { WebviewToHost } from "./protocol";

/**
 * Dialogue lifecycle for a chat surface: opening a dialogue (new / resumed /
 * handed-off-seed), terminal-backed dialogues, read-only follow mirrors, the
 * restore-on-open and default-start flows, and the branch flows (restart from a
 * message, edit & resend). Extracted from ChatSurface as a collaborator; the
 * surface keeps the actual session state (controller/terminal/follow handle)
 * and exposes it here via getters/setters so the surface stays the owner.
 */
export interface SurfaceDialoguesDeps {
    deps: ChatSurfaceDeps;
    chatOnly: boolean;
    /** Raw webview for boot messages that must bypass the ready-queue. */
    webview: vscode.Webview;
    post: (message: unknown) => void;
    getController: () => ChatController | undefined;
    setController: (c: ChatController | undefined) => void;
    setTerminalSession: (t: TerminalSession | undefined) => void;
    setFollowHandle: (h: FollowHandle | undefined) => void;
    setFollowedSessionId: (id: string | undefined) => void;
    /** Detaches (not stops) the current dialogue/terminal/follow before binding a new one. */
    detachActive: () => void;
    buildLangHint: () => string;
    onTitleChange?: (title: string) => void;
    sync: SurfaceSync;
    changedFiles: ChangedFilesManager;
}

export class SurfaceDialogues {
    constructor(private readonly d: SurfaceDialoguesDeps) { }

    /** Restores the last active session on open, or starts a default dialogue. */
    async restoreOrStart(): Promise<void> {
        const last = this.d.deps.lastActive.get();
        if (last) {
            // Time-bound: a backend's listSessions() (e.g. HTTP model discovery)
            // can hang on code-server with no network/auth; never let it block
            // startup and trap the UI on the boot screen.
            const sessions = await Promise.race([
                this.d.deps.listSessions().catch(() => [] as SessionInfo[]),
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
    startDefaultDialogue(): void {
        const backend = this.d.deps.adapterByBackend.keys().next().value;
        if (!backend) {
            void this.d.webview.postMessage({ type: "boot", id: "session", label: "No backend available", status: "fail", detail: "configure an adapter" });
            void this.d.webview.postMessage({ type: "boot", complete: true });
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
    restartFromMessage(index: number): void {
        const from = this.d.getController();
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
        this.d.post({
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
    editResend(anchorIndex: number, sendMsg: WebviewToHost): void {
        const from = this.d.getController();
        if (!from || !Number.isInteger(anchorIndex) || anchorIndex < 0) {
            // Nothing to rewind to — treat as a normal send.
            void this.d.getController()?.handleMessage({ ...sendMsg, editFrom: undefined });
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
            this.d.post({ type: "history", messages, carried: true });
        }
        void this.d.getController()?.handleMessage({
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
            { cwd: this.d.deps.cwdFor(info), resumeSessionId: info.sessionId },
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
        const adapter = this.d.deps.adapterByBackend.get(info.backend);
        if (!adapter?.follow) {
            // No live mirror for this backend — fall back to resume.
            this.openSession(info);
            return;
        }
        this.d.detachActive();
        this.d.post({ type: "clear" });
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.d.post({
            type: "meta",
            backend: adapter.backend,
            backendName: adapter.displayName,
            modelLabels: adapter.modelLabels?.() ?? {},
            resumed: true,
            readOnly: true,
            busy: false,
            models: [],
            sessionId: info.sessionId,
            title: info.title,
            sessionsSide,
            chatOnly: this.d.chatOnly,
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", "queue"),
            execDisplay: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
        });
        if (adapter.history) {
            try {
                const messages = await adapter.history(info);
                this.d.post({ type: "history", messages });
            } catch {
                // ignore; live tail still attaches below
            }
        }
        const handle = adapter.follow(info, (message) => {
            this.d.post({ type: "append", message });
        });
        this.d.setFollowHandle(handle);
        // The followed process has no local controller, so its working/idle is
        // inferred from the transcript and published to the runtime, which the
        // sessions list reads via statusFor — same indicator as live sessions.
        this.d.setFollowedSessionId(info.sessionId);
        handle.onStatus?.((status) => {
            this.d.deps.runtime.setFollowStatus(info.sessionId, status);
        });
        this.d.onTitleChange?.(`👁 ${info.title} · ${adapter.backend}`);
    }

    /**
     * Terminal-backed dialogue: Symposium launches the CLI in a visible VS
     * Code terminal it owns, so the composer drives the same interactive
     * process the user can also type into. Full two-way control of one live
     * session. `env`/`model` come from the adapter's configuration.
     */
    openTerminalDialogue(backend: string, options: SessionStartOptions & { env?: Record<string, string>; tmuxName?: string; reasoning?: string }, title: string): void {
        const adapter = this.d.deps.adapterByBackend.get(backend);
        if (!adapter) {
            return;
        }
        this.d.detachActive();
        this.d.post({ type: "clear" });
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.d.post({
            type: "meta",
            backend: adapter.backend,
            backendName: adapter.displayName,
            modelLabels: adapter.modelLabels?.() ?? {},
            resumed: !!options.resumeSessionId,
            terminal: true,
            busy: false,
            models: [],
            sessionId: options.resumeSessionId ?? "",
            title,
            sessionsSide,
            chatOnly: this.d.chatOnly,
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
        const terminal = new TerminalSession(
            adapter,
            { cwd: options.cwd, resumeSessionId: options.resumeSessionId, model: options.model, reasoning: options.reasoning, env: options.env, tmuxName: options.tmuxName },
            (message) => this.d.post(message),
            symposiumLog,
            (sessionId, status) => this.d.deps.runtime.setFollowStatus(sessionId, status),
        );
        this.d.setTerminalSession(terminal);
        if (options.tmuxName) {
            this.d.post({ type: "event", event: { kind: "tool-start", toolName: "tmux", detail: options.tmuxName + " — survives VS Code closing" } });
        }
        void terminal.start();
        this.d.sync.postCommands(adapter);
        this.d.sync.refreshModels(adapter);
        this.d.onTitleChange?.(`▷ ${title} · ${adapter.backend}`);
    }

    /**
     * Opens a dialogue (new or resumed) in this surface. Switching away from a
     * running session DETACHES it (it keeps working in the background) instead
     * of stopping it; returning to it re-attaches and replays its output.
     */
    openDialogue(backend: string, options: SessionStartOptions, title: string, info?: SessionInfo): void {
        const adapter = this.d.deps.adapterByBackend.get(backend);
        if (!adapter) {
            return;
        }
        this.d.detachActive();
        this.d.post({ type: "clear" });

        // New (non-resumed) sessions: inject the language hint and the
        // per-workspace bootstrap (standing Sufficit context) before the first
        // message. The bootstrap link is surfaced on the empty screen so the user
        // can read its source file. Resumed sessions already carry their context.
        let bootstrapLink: { path: string; name: string } | undefined;
        if (!options.resumeSessionId) {
            const langHint = this.d.buildLangHint();
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
            ? this.d.deps.runtime.findBySessionId(options.resumeSessionId)
            : undefined;
        const controller = existing ?? this.d.deps.runtime.create(adapter, options);
        // Restore the exact visual for a reopened session: seed the render log
        // (replayed when the sink binds below) so tool rows, diffs, status notices
        // and panels reappear — not just text. Skips lossy history reconstruction.
        const seededVisual = !existing && !!options.resumeSessionId && controller.seedRenderLog();
        this.d.setController(controller);
        void this.d.sync.refreshTasks();   // load this session's tasks into the panel
        void this.d.sync.refreshGuardrails();

        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.d.post({
            type: "meta",
            backend: adapter.backend,
            backendName: adapter.displayName,
            modelLabels: adapter.modelLabels?.() ?? {},
            // Inline badge for an agent-def-bound dialogue (once, first turn; null = plain). See SessionStartOptions.
            agentLabels: options.agentName
                ? { agent: options.agentName, toolsDeclared: options.toolsDeclared ?? [], toolsAllowed: options.toolsAllowed ?? [] }
                : null,
            bootstrapLink: bootstrapLink ?? null,   // per-workspace bootstrap link (null = none)
            resumed: !!options.resumeSessionId,
            models: adapter.models?.() ?? [],
            reasoningLevels: adapter.reasoningLevels?.() ?? [],
            reasoningDefault: vscode.workspace.getConfiguration("symposium." + adapter.backend).get<string>("reasoning", "default"),
            modelDefault: vscode.workspace.getConfiguration("symposium." + adapter.backend).get<string>("model", ""),
            pinnedModels: this.d.deps.modelPrefs.getPinned(adapter.backend),
            // Last model used in this session (resume), so the picker restores it
            // instead of defaulting to the first discovered model.
            sessionModel: info?.model ?? "",
            // Attach-browser-page button only shows when a Simple Browser is open.
            browserOpen: isSimpleBrowserOpen(),
            // Per-session tool gating for the native AI backend (undefined for CLIs).
            aiTools: controller.aiToolsInfo?.(),
            // Real busy state (resets a stuck "thinking" compose on reopen).
            busy: controller.isBusy,
            permissionModes: adapter.permissionModes?.() ?? [],
            permission: adapter.defaultPermission?.() ?? "default",
            sessionId: options.resumeSessionId ?? "",
            title,
            sessionsSide,
            chatOnly: this.d.chatOnly,
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
            const msg = message as Record<string, unknown> | null;
            if (msg?.type === "changed-files" && "items" in msg && Array.isArray(msg.items)) {
                void this.d.changedFiles.refresh(msg.items);
                return;
            }
            // Capture a freshly-assigned session id so a brand-new dialogue
            // also becomes the restorable "last active" one.
            const ev = msg?.event as { kind?: string; sessionId?: string } | undefined;
            if (ev?.kind === "session" && ev.sessionId) {
                this.d.deps.lastActive.set({ backend, sessionId: ev.sessionId });
            }
            // Repaint the affected panel the moment a session-mutating tool finishes,
            // so an agent-added guardrail / task shows immediately instead of only at
            // turn-end. (A short retry covers the hub search index settling.)
            if (ev?.kind === "tool-end" && typeof ev.toolName === "string") {
                const n = ev.toolName;
                if (n === "add_guardrail" || n === "clear_guardrails") {
                    const repaint = () => void this.d.getController()?.reloadGuardrails().then(() => this.d.sync.refreshGuardrails());
                    repaint(); setTimeout(repaint, 700);
                } else if (n === "add_task" || n === "task_complete" || (n === "memory_save")) {
                    void this.d.sync.refreshTasks(); setTimeout(() => void this.d.sync.refreshTasks(), 700);
                }
            }
            // Refresh the Tasks panel when a turn ends: the agent may have saved
            // task-checkpoints mid-turn (bound to this session), which the panel
            // otherwise wouldn't pick up until reopen/manual refresh.
            if (ev?.kind === "turn-end") {
                void this.d.sync.refreshTasks();
                // The agent may have added a guardrail mid-turn (add_guardrail tool):
                // reload the controller's injection cache and repaint the panel.
                void this.d.getController()?.reloadGuardrails().then(() => this.d.sync.refreshGuardrails());
                // Re-mirror the working tree from git: a turn may have edited files
                // via shell/sed (no tool event, no index change) that the live
                // changed-files signal and the .git/index watcher both miss.
                this.d.changedFiles.refreshNow();
            }
            this.d.post(message);
        });
        if (!existing && info && !seededVisual) {
            void controller.loadHistory(info);
        }
        if (options.resumeSessionId) {
            this.d.deps.lastActive.set({ backend, sessionId: options.resumeSessionId });
        }
        // The render-log replay above may have set busy=true (user messages in
        // the log trigger setBusy(true) in the webview). Re-assert the real busy
        // state AFTER the replay so the compose button is correct.
        this.d.post({ type: "busy", busy: controller.isBusy });
        this.d.sync.postCommands(adapter);
        this.d.sync.refreshModels(adapter);
        this.d.onTitleChange?.(`${title} · ${adapter.backend}`);
    }
}
