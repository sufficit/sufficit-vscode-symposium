import * as vscode from "vscode";
import { WebviewToHost } from "../protocol/chat";
import { setTaskDone } from "../sync/tasks";
import { clearSurfaceGuardrails, removeSurfaceGuardrail } from "./surfaceGuardrails";
import { handleVoiceMessage } from "./surfaceMessageVoice";
import { handleFileMessage } from "./surfaceMessageFiles";
import { handleChangedFilesMessage } from "./surfaceMessageChangedFiles";
import { handleSessionMessage } from "./surfaceMessageSessions";
import { symposiumLog } from "../extension/log";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";
import { handleMarkdownImageMessage } from "./surfaceMessageMarkdown";
import { resolveLocalFileTarget } from "./markdownImages";
import { handleSurfaceCommandMessage } from "./surfaceMessageCommands";

/**
 * Webview → host message router for a chat surface: the big switch that turns
 * each posted message into the right action on the surface's collaborators.
 * Extracted from ChatSurface; session state stays surface-owned and is reached
 * here through getters/callbacks in the deps bag.
 */
export type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

export class SurfaceMessages {
    constructor(private readonly d: SurfaceMessagesDeps) {}

    async handle(message: WebviewToHost): Promise<void> {
        symposiumLog(
            `[surface] <- webview: ${message?.type}${message?.type === "send" ? ` (${(message.text ?? "").length} chars)` : ""}`,
        );
        try {
            if (await handleSurfaceCommandMessage(message, this.d)) {
                return;
            }
            switch (message?.type) {
                case "ready": {
                    this.d.markReady();
                    if (!this.d.chatOnly || this.d.startInSessionsList) {
                        void this.d.refreshSessions();
                    }
                    void this.d.sync.pushAccount();
                    void this.d.sync.refreshTasks();
                    void this.d.sync.refreshGuardrails();
                    // The sidebar restores its last session only when it is the
                    // configured chat destination. In editor mode the sidebar is
                    // deliberately a sessions navigator, so restoring here would
                    // replace the navigator with the active conversation.
                    const openIn = vscode.workspace
                        .getConfiguration("symposium.chat")
                        .get<string>("openIn", "editor");
                    if (
                        !this.d.chatOnly &&
                        openIn !== "editor" &&
                        !this.d.getController() &&
                        !this.d.getFollowHandle() &&
                        !this.d.getTerminalSession()
                    ) {
                        void this.d.dialogues.restoreOrStart();
                    }
                    return;
                }
                case "open-active-session": {
                    const last = this.d.deps.lastActive.get();
                    if (!last) {
                        this.d.post({ type: "toast", text: "No active session to return to." });
                        return;
                    }
                    const sessions = await this.d.deps.listSessions();
                    const info = sessions.find(
                        (s) => s.sessionId === last.sessionId && s.backend === last.backend,
                    );
                    if (info) {
                        this.d.openSession(info);
                    } else {
                        this.d.post({
                            type: "toast",
                            text: "The active session is no longer available.",
                        });
                    }
                    return;
                }
                case "webview-error": {
                    symposiumLog(`[webview] ERROR: ${message.message}`);
                    return;
                }
                case "set-tools": {
                    if (Array.isArray(message.tools)) {
                        this.d
                            .getController()
                            ?.setAiTools(message.tools.map((t: unknown) => String(t)));
                    }
                    return;
                }
                case "pick-attachments": {
                    const picked = await this.d.getController()?.pickAttachments();
                    if (picked?.length) {
                        this.d.post({ type: "attachments-picked", files: picked });
                    }
                    return;
                }
                case "attach-browser-page": {
                    await this.d.sync.attachBrowserPage();
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
                case "remote-access": {
                    await vscode.commands.executeCommand("symposium.showRemoteAccess");
                    return;
                }
                case "open-session-editor": {
                    const sessionsEditor = await this.d.deps.listSessions();
                    const infoEditor = sessionsEditor.find(
                        (s) => s.sessionId === message.sessionId && s.backend === message.backend,
                    );
                    if (infoEditor) {
                        await vscode.commands.executeCommand(
                            "symposium.openSessionInEditor",
                            infoEditor,
                        );
                    }
                    return;
                }
                case "open-session": {
                    const sessions = await this.d.deps.listSessions();
                    const info = sessions.find(
                        (s) => s.sessionId === message.sessionId && s.backend === message.backend,
                    );
                    if (info) {
                        this.d.openSession(info);
                    }
                    return;
                }
                case "paste-image":
                case "drop-file":
                case "drop-files":
                case "drop-uris": {
                    if (await handleFileMessage(message, this.d)) {
                        return;
                    }
                    return;
                }
                case "voice-start":
                case "voice-stop":
                case "voice-cancel":
                case "stt-transcribe": {
                    if (await handleVoiceMessage(message, this.d)) {
                        return;
                    }
                    return;
                }
                case "refresh-tasks": {
                    void this.d.sync.refreshTasks();
                    return;
                }
                case "refresh-quotas": {
                    await this.d.refreshQuotas(true);
                    return;
                }
                case "task-set-done": {
                    if (typeof message.id === "string" && this.d.hub.configured()) {
                        const done = message.done === true;
                        const ok = await setTaskDone(this.d.hub, message.id, done);
                        if (ok) {
                            this.d.sync.setTasksDoneByIds([message.id], done);
                        } else {
                            void this.d.sync.refreshTasks();
                        }
                    }
                    return;
                }
                case "remove-guardrail": {
                    if (typeof message.id === "string") {
                        await removeSurfaceGuardrail(this.d.hub, message.id);
                        await this.d.getController()?.reloadGuardrails();
                        void this.d.sync.refreshGuardrails();
                    }
                    return;
                }
                case "clear-guardrails": {
                    const sid = this.d.getController()?.sessionId;
                    if (sid) {
                        const ok = await vscode.window.showWarningMessage(
                            "Clear all guardrails for this session?",
                            { modal: true },
                            "Clear",
                        );
                        if (ok === "Clear") {
                            await clearSurfaceGuardrails(this.d.hub, sid);
                            await this.d.getController()?.reloadGuardrails();
                            void this.d.sync.refreshGuardrails();
                        }
                    }
                    return;
                }
                case "restart-from-message": {
                    if (typeof message.index === "number") {
                        this.d.dialogues.restartFromMessage(message.index);
                    }
                    return;
                }
                case "retry-last-message": {
                    if (typeof message.index === "number") {
                        this.d.dialogues.retryLastMessage(
                            message.index,
                            message.errorMessage,
                            message.text,
                        );
                    }
                    return;
                }
                case "load-more-history": {
                    // Scroll-up pagination: load the next older history page from
                    // the backend transcript. The controller stores the cursor
                    // returned by the previous page; loadMoreHistory is a no-op
                    // when no cursor remains (transcript fully loaded).
                    await this.d.getController()?.loadMoreHistory();
                    return;
                }
                case "open-settings": {
                    await vscode.commands.executeCommand("symposium.openSettings");
                    return;
                }
                case "inspect": {
                    await this.d.sync.openInspectView(message.target);
                    return;
                }
                case "open-file": {
                    if (typeof message.path === "string" && message.path.trim()) {
                        // Paths clicked from agent replies may be absolute or
                        // workspace-relative. file: URIs and `~` are valid too.
                        const cwd =
                            this.d.getController()?.cwd ??
                            this.d.getTerminalSession()?.cwd ??
                            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(
                            (folder) => folder.uri.fsPath,
                        );
                        const target = resolveLocalFileTarget(message.path, cwd, workspaceRoots);
                        if (!target) {
                            return;
                        }
                        // vscode.open handles text AND binary (images open in the
                        // image preview), unlike openTextDocument.
                        const selection = target.line
                            ? new vscode.Range(
                                  target.line - 1,
                                  (target.column ?? 1) - 1,
                                  target.line - 1,
                                  (target.column ?? 1) - 1,
                              )
                            : undefined;
                        await vscode.commands.executeCommand(
                            "vscode.open",
                            vscode.Uri.file(target.fsPath),
                            { preview: true, selection },
                        );
                    }
                    return;
                }
                case "resolve-markdown-image": {
                    await handleMarkdownImageMessage(message, this.d);
                    return;
                }
                case "reorder-pinned": {
                    await vscode.commands.executeCommand(
                        "symposium.reorderPinned",
                        message.ids ?? [],
                    );
                    return;
                }
                case "file-diff": {
                    await this.d.changedFiles.openDiff(message.path);
                    return;
                }
                case "show-manual": {
                    if (typeof message.manualId === "string" && message.manualId.trim()) {
                        await vscode.commands.executeCommand(
                            "symposium.showManual",
                            message.manualId,
                        );
                    }
                    return;
                }
                case "show-tool-manual": {
                    await vscode.commands.executeCommand(
                        "symposium.showToolManual",
                        message.toolName,
                    );
                    return;
                }
                case "file-approve":
                case "file-reject":
                case "file-approve-all":
                case "file-reject-all": {
                    if (await handleChangedFilesMessage(message, this.d)) {
                        return;
                    }
                    return;
                }
                case "refresh-sessions": {
                    const all = await this.d.deps.listSessions();
                    this.d.post({
                        type: "sessions",
                        items: all.map((s) => ({ ...s, updatedAt: s.updatedAt?.toISOString() })),
                    });
                    return;
                }
                case "session-action":
                case "session-list-backends":
                case "session-switch-backend": {
                    if (await handleSessionMessage(message, this.d)) {
                        return;
                    }
                    return;
                }
                default: {
                    // The webview disables the composer for stored read-only
                    // sessions, but enforce the same policy host-side so a
                    // stale UI event cannot start a new dialogue or reach Codex.
                    if (message?.type === "send" && this.d.getSendBlockedReason()) {
                        return;
                    }
                    const term = this.d.getTerminalSession();
                    if (term && message?.type === "send") {
                        term.send(message.text);
                        return;
                    }
                    if (term && message?.type === "cancel") {
                        return; // the user interrupts in the terminal itself
                    }
                    // Edit & resend: rewind to before the edited message, then send.
                    if (
                        message?.type === "send" &&
                        message.editFrom != null &&
                        this.d.getController()
                    ) {
                        this.d.dialogues.editResend(message.editFrom, message);
                        return;
                    }
                    if (!this.d.getController() && message?.type === "send") {
                        // Composer used before any dialogue was opened — start one now,
                        // then deliver this message to it.
                        this.d.dialogues.startDefaultDialogue();
                    }
                    if (this.d.ahp.handleMessage(message)) {
                        return;
                    }
                    if (isAhpControllerMessage(message)) {
                        throw new Error("AHP session is unavailable");
                    }
                    return;
                }
            }
        } catch (error) {
            symposiumLog(
                `[surface] ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
            );
            // Only a "send" drives the agent's turn. Any other message is a UI
            // command (open-file, file-diff, etc.); a failure there is local and
            // must NOT be treated as a turn-ending (fatal) error, otherwise it
            // would flip the composer's send/stop button as if the agent stopped.
            const fatal = message?.type === "send";
            void this.d.webview.postMessage({
                type: "event",
                event: {
                    kind: "error",
                    message: error instanceof Error ? error.message : String(error),
                    fatal,
                },
            });
        }
    }
}

function isAhpControllerMessage(message: WebviewToHost): boolean {
    return (
        message.type === "send" ||
        message.type === "cancel" ||
        message.type === "continue" ||
        message.type === "queue-remove" ||
        message.type === "queue-edit" ||
        message.type === "queue-promote" ||
        message.type === "queue-clear" ||
        message.type === "approval-response"
    );
}
