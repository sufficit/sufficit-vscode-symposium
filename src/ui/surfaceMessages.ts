import * as vscode from "vscode";
import { FollowHandle, SessionInfo } from "../adapters/types";
import { WebviewToHost } from "./protocol";
import { ChatController } from "./chatController";
import { TerminalSession } from "./terminalSession";
import type { ChatSurfaceDeps } from "./chatSurface";
import { SurfaceSync } from "./surfaceSync";
import { SurfaceDialogues } from "./surfaceDialogues";
import { BackendHandoff } from "./backendHandoff";
import { ChangedFilesManager } from "./changedFiles";
import { HubClient } from "../sync/hubClient";
import { setTaskDone } from "../sync/tasks";
import { removeGuardrail, clearSessionGuardrails } from "../sync/guardrails";
import { probeRtk } from "../adapters/rtk";
import { writeDroppedFile, writePastedImage, attachmentFromUri } from "./chatSurfaceContext";
import { symposiumLog } from "../extension";

/**
 * Webview → host message router for a chat surface: the big switch that turns
 * each posted message into the right action on the surface's collaborators.
 * Extracted from ChatSurface; session state stays surface-owned and is reached
 * here through getters/callbacks in the deps bag.
 */
export interface SurfaceMessagesDeps {
    webview: vscode.Webview;
    deps: ChatSurfaceDeps;
    post: (message: unknown) => void;
    /** Marks the webview ready: flips ready, sends the host boot, flushes the queue. */
    markReady: () => void;
    refreshSessions: () => Promise<void>;
    openSession: (info: SessionInfo) => void;
    getController: () => ChatController | undefined;
    getTerminalSession: () => TerminalSession | undefined;
    getFollowHandle: () => FollowHandle | undefined;
    sync: SurfaceSync;
    dialogues: SurfaceDialogues;
    handoff: BackendHandoff;
    changedFiles: ChangedFilesManager;
    hub: HubClient;
}

export class SurfaceMessages {
    constructor(private readonly d: SurfaceMessagesDeps) { }

    async handle(message: WebviewToHost): Promise<void> {
        symposiumLog(`[surface] <- webview: ${message?.type}${message?.type === "send" ? ` (${(message.text ?? "").length} chars)` : ""}`);
        try {
            switch (message?.type) {
                case "ready": {
                    this.d.markReady();
                    void this.d.refreshSessions();
                    void this.d.sync.pushAccount();
                    void this.d.sync.refreshTasks();
                    void this.d.sync.refreshGuardrails();
                    // Nothing bound yet (view just opened): restore the last
                    // active session if we have one, else start a fresh dialogue.
                    if (!this.d.getController() && !this.d.getFollowHandle() && !this.d.getTerminalSession()) {
                        void this.d.dialogues.restoreOrStart();
                    }
                    return;
                }
                case "webview-error": {
                    symposiumLog(`[webview] ERROR: ${message.message}`);
                    return;
                }
                case "set-tools": {
                    if (Array.isArray(message.tools)) {
                        this.d.getController()?.setAiTools(message.tools.map((t: unknown) => String(t)));
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
                case "open-session": {
                    const sessions = await this.d.deps.listSessions();
                    const info = sessions.find((s) => s.sessionId === message.sessionId && s.backend === message.backend);
                    if (info) {
                        this.d.openSession(info);
                    }
                    return;
                }
                case "paste-image": {
                    const file = await writePastedImage(message.mime, message.data);
                    if (file) {
                        this.d.post({ type: "attachments-picked", files: [file] });
                    }
                    return;
                }
                case "drop-file": {
                    const file = await writeDroppedFile(message.name, message.mime, message.data ?? "");
                    if (file) {
                        this.d.post({ type: "attachments-picked", files: [file] });
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
                        this.d.post({ type: "attachments-picked", files });
                    }
                    return;
                }
                case "drop-uris": {
                    const files = Array.isArray(message.uris)
                        ? message.uris.map((u: string) => attachmentFromUri(u)).filter((f: { path: string; name: string } | undefined): f is { path: string; name: string } => Boolean(f))
                        : [];
                    if (files.length) {
                        this.d.post({ type: "attachments-picked", files });
                    }
                    return;
                }
                case "refresh-tasks": {
                    void this.d.sync.refreshTasks();
                    return;
                }
                case "task-set-done": {
                    if (typeof message.id === "string" && this.d.hub.configured()) {
                        await setTaskDone(this.d.hub, message.id, message.done === true);
                        void this.d.sync.refreshTasks();
                    }
                    return;
                }
                case "remove-guardrail": {
                    if (typeof message.id === "string" && this.d.hub.configured()) {
                        await removeGuardrail(this.d.hub, message.id);
                        await this.d.getController()?.reloadGuardrails();
                        void this.d.sync.refreshGuardrails();
                    }
                    return;
                }
                case "clear-guardrails": {
                    const sid = this.d.getController()?.sessionId;
                    if (sid && this.d.hub.configured()) {
                        const ok = await vscode.window.showWarningMessage("Clear all guardrails for this session?", { modal: true }, "Clear");
                        if (ok === "Clear") {
                            await clearSessionGuardrails(this.d.hub, sid);
                            await this.d.getController()?.reloadGuardrails();
                            void this.d.sync.refreshGuardrails();
                        }
                    }
                    return;
                }
                case "recheck-shell-tools": {
                    // Re-probe rtk (e.g. after the user installed it); the result
                    // gates the RTK preamble on the next turn.
                    const cwd = this.d.getController()?.cwd ?? process.cwd();
                    void probeRtk(cwd, true).then((ok) => {
                        this.d.post({ type: "toast", text: ok ? "rtk found — compact output enabled" : "rtk not found — using plain shell tools" });
                    });
                    return;
                }
                case "refresh-models": {
                    // Re-run remote model discovery for the current dialogue's
                    // backend (e.g. after logging in, so GET /models stops 401ing).
                    const current = this.d.getController()?.backend ?? this.d.getTerminalSession()?.backend;
                    const adapter = current ? this.d.deps.adapterByBackend.get(current) : undefined;
                    if (adapter) {
                        this.d.sync.refreshModels(adapter, true);   // explicit: force a fresh GET /models
                    }
                    return;
                }
                case "pin-model": {
                    const pinBackend = this.d.getController()?.backend ?? this.d.getTerminalSession()?.backend;
                    if (pinBackend && typeof message.model === "string") {
                        const pinned = this.d.deps.modelPrefs.getPinned(pinBackend);
                        const idx = pinned.indexOf(message.model);
                        if (idx >= 0) { pinned.splice(idx, 1); } else { pinned.push(message.model); }
                        this.d.deps.modelPrefs.setPinned(pinBackend, pinned);
                        this.d.post({ type: "model-prefs", pinnedModels: pinned });
                    }
                    return;
                }
                case "set-model-default": {
                    const defBackend = this.d.getController()?.backend ?? this.d.getTerminalSession()?.backend;
                    if (defBackend && typeof message.model === "string") {
                        const defModel = message.model || undefined;
                        await this.d.deps.modelPrefs.setDefault(defBackend, defModel);
                        this.d.post({ type: "model-prefs", modelDefault: message.model });
                    }
                    return;
                }
                case "new-session": {
                    await vscode.commands.executeCommand("symposium.newSession");
                    return;
                }
                case "set-compression-preset": {
                    const controller = this.d.getController();
                    if (controller && typeof message.compressionPresetId === "string") {
                        const sessionId = controller.sessionId;
                        if (sessionId) {
                            const { CompressionManager } = await import("../compression");
                            const compressionManager = CompressionManager.getInstance();
                            const presetId = message.compressionPresetId || undefined;
                            if (presetId) {
                                compressionManager.setSectionConfig(sessionId, presetId);
                            } else {
                                compressionManager.removeSectionConfig(sessionId);
                            }
                            this.d.post({ type: "compression-preset-set", presetId });
                        }
                    }
                    return;
                }
                case "list-backends": {
                    // Offer the agents the current dialogue can be handed off to
                    // (every configured backend except the one in use now). The
                    // current backend may come from a chat controller OR a
                    // terminal session.
                    const current = this.d.getController()?.backend ?? this.d.getTerminalSession()?.backend;
                    const items = [...this.d.deps.adapterByBackend.values()].map((adapter) => ({
                        backend: adapter.backend,
                        name: adapter.displayName ?? adapter.backend,
                        current: adapter.backend === current,
                    }));
                    this.d.post({ type: "backends", items });
                    return;
                }
                case "switch-backend": {
                    if (typeof message.backend === "string") {
                        // A terminal session has no ChatController transcript, so
                        // its handoff reads the CLI transcript instead.
                        if (this.d.getTerminalSession() && !this.d.getController()) {
                            await this.d.handoff.fromTerminal(message.backend);
                        } else {
                            this.d.handoff.switch(message.backend);
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
                case "open-settings": {
                    await vscode.commands.executeCommand("symposium.openSettings");
                    return;
                }
                case "inspect": {
                    await this.d.sync.openInspectView(message.target);
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
                    await this.d.changedFiles.openDiff(message.path);
                    return;
                }
                case "file-approve": {
                    if (typeof message.path === "string") {
                        await this.d.changedFiles.approve(message.path);
                        this.d.changedFiles.refreshNow();
                    }
                    return;
                }
                case "file-reject": {
                    if (typeof message.path === "string") {
                        if (await this.d.changedFiles.reject(message.path)) { this.d.getController()?.resolveChanged(message.path); }
                        else { void vscode.window.showWarningMessage("Could not revert " + message.path); }
                    }
                    return;
                }
                case "file-approve-all": {
                    for (const p of this.d.getController()?.changedPaths() ?? []) {
                        await this.d.changedFiles.approve(p);
                    }
                    this.d.changedFiles.refreshNow();
                    return;
                }
                case "file-reject-all": {
                    const paths = this.d.getController()?.changedPaths() ?? [];
                    if (!paths.length) { return; }
                    const pick = await vscode.window.showWarningMessage(
                        `Revert ${paths.length} file(s) to their pre-edit state? This discards the agent's changes.`,
                        { modal: true }, "Revert");
                    if (pick !== "Revert") { return; }
                    for (const p of paths) {
                        if (await this.d.changedFiles.reject(p)) { this.d.getController()?.resolveChanged(p); }
                    }
                    return;
                }
                case "session-action": {
                    const sessions = await this.d.deps.listSessions();
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
                    if (!command) {
                        return;
                    }
                    // Archive / unarchive / delete cascade across the whole
                    // conversation lineage — a conversation (sessions sharing a
                    // lineageId) is atomic, so the action hits all of its sessions.
                    if (message.action === "archive" || message.action === "unarchive" || message.action === "delete") {
                        const lineageKey = info.lineageId || info.sessionId;
                        const targets = sessions.filter((s) => (s.lineageId || s.sessionId) === lineageKey);
                        if (message.action === "delete" && targets.length > 1) {
                            const confirm = await vscode.window.showWarningMessage(
                                `Permanently delete this conversation and all ${targets.length} of its sessions? Every transcript is scrubbed from disk and it cannot be undone.`,
                                { modal: true },
                                "Delete all",
                            );
                            if (confirm !== "Delete all") {
                                return;
                            }
                            for (const target of targets) {
                                await vscode.commands.executeCommand("symposium.deleteSession", target, { skipConfirm: true });
                            }
                            return;
                        }
                        for (const target of targets) {
                            await vscode.commands.executeCommand(command, target);
                        }
                        return;
                    }
                    await vscode.commands.executeCommand(command, info);
                    return;
                }
                case "session-list-backends": {
                    // "Continue with another agent" from a session's right-click
                    // menu: offer every configured backend except the session's own.
                    const items = [...this.d.deps.adapterByBackend.values()].map((adapter) => ({
                        backend: adapter.backend,
                        name: adapter.displayName ?? adapter.backend,
                        current: adapter.backend === message.backend,
                    }));
                    this.d.post({ type: "session-backends", items });
                    return;
                }
                case "session-switch-backend": {
                    if (
                        typeof message.sessionId === "string" &&
                        typeof message.backend === "string" &&
                        typeof message.targetBackend === "string"
                    ) {
                        await this.d.handoff.forSession(
                            message.sessionId,
                            message.backend,
                            message.targetBackend,
                        );
                    }
                    return;
                }
                default: {
                    const term = this.d.getTerminalSession();
                    if (term && message?.type === "send") {
                        term.send(message.text);
                        return;
                    }
                    if (term && message?.type === "cancel") {
                        return; // the user interrupts in the terminal itself
                    }
                    // Edit & resend: rewind to before the edited message, then send.
                    if (message?.type === "send" && message.editFrom != null && this.d.getController()) {
                        this.d.dialogues.editResend(message.editFrom, message);
                        return;
                    }
                    if (!this.d.getController() && message?.type === "send") {
                        // Composer used before any dialogue was opened — start one now,
                        // then deliver this message to it.
                        this.d.dialogues.startDefaultDialogue();
                    }
                    await this.d.getController()?.handleMessage(message);
                }
            }
        } catch (error) {
            symposiumLog(`[surface] ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            // Only a "send" drives the agent's turn. Any other message is a UI
            // command (open-file, file-diff, etc.); a failure there is local and
            // must NOT be treated as a turn-ending (fatal) error, otherwise it
            // would flip the composer's send/stop button as if the agent stopped.
            const fatal = message?.type === "send";
            void this.d.webview.postMessage({
                type: "event",
                event: { kind: "error", message: error instanceof Error ? error.message : String(error), fatal },
            });
        }
    }
}
