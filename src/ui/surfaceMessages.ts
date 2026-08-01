import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { WebviewToHost } from "./protocol";
import { setTaskDone } from "../sync/tasks";
import { removeGuardrail, clearSessionGuardrails } from "../sync/guardrails";
import { probeRtk } from "../adapters/rtk";
import { handleVoiceMessage } from "./surfaceMessageVoice";
import { handleFileMessage } from "./surfaceMessageFiles";
import { handleChangedFilesMessage } from "./surfaceMessageChangedFiles";
import { handleSessionMessage } from "./surfaceMessageSessions";
import { symposiumLog } from "../extension";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

/**
 * Webview → host message router for a chat surface: the big switch that turns
 * each posted message into the right action on the surface's collaborators.
 * Extracted from ChatSurface; session state stays surface-owned and is reached
 * here through getters/callbacks in the deps bag.
 */
export type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

export class SurfaceMessages {
    constructor(private readonly d: SurfaceMessagesDeps) { }

    async handle(message: WebviewToHost): Promise<void> {
        symposiumLog(`[surface] <- webview: ${message?.type}${message?.type === "send" ? ` (${(message.text ?? "").length} chars)` : ""}`);
        try {
            switch (message?.type) {
                case "ready": {
                    this.d.markReady();
                    if (!this.d.chatOnly) { void this.d.refreshSessions(); }
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
                case "remote-access": {
                    await vscode.commands.executeCommand("symposium.showRemoteAccess");
                    return;
                }
                case "open-session-editor": {
                    const sessionsEditor = await this.d.deps.listSessions();
                    const infoEditor = sessionsEditor.find((s) => s.sessionId === message.sessionId && s.backend === message.backend);
                    if (infoEditor) {
                        await vscode.commands.executeCommand("symposium.openSessionInEditor", infoEditor);
                    }
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
                case "paste-image":
                case "drop-file":
                case "drop-files":
                case "drop-uris": {
                    if (await handleFileMessage(message, this.d)) { return; }
                    return;
                }
                case "voice-start":
                case "voice-stop":
                case "voice-cancel":
                case "stt-transcribe": {
                    if (await handleVoiceMessage(message, this.d)) { return; }
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
                        if (ok) { this.d.sync.setTasksDoneByIds([message.id], done); }
                        else { void this.d.sync.refreshTasks(); }
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
                case "set-model": {
                    // Persistir o modelo selecionado no controller atual
                    const controller = this.d.getController();
                    if (controller && typeof message.model === "string") {
                        // Atualizar o modelo no controller
                        controller.setModel(message.model);
                        // Forçar persistência imediata do modelo no adapter
                        const session = controller.getSession();
                        if (session?.safePersist) {
                            session.safePersist();
                        }
                        // Notificar a webview que o modelo foi atualizado
                        this.d.post({ type: "session-model-updated", model: message.model });
                        // Usage is scoped by Sufficit preset. Refresh immediately
                        // so the footer never keeps the previous preset's balance.
                        await this.d.refreshQuotas(true);
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
                case "new-editor-session": {
                    await vscode.commands.executeCommand("symposium.newEditorSession");
                    return;
                }
                case "pick-session": {
                    await vscode.commands.executeCommand("symposium.pickEditorSession");
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
                                await compressionManager.setSectionConfig(sessionId, presetId);
                            } else {
                                await compressionManager.removeSectionConfig(sessionId);
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
                            this.d.handoff.fromTerminal(message.backend);
                        } else {
                            this.d.handoff.switch(message.backend);
                        }
                    }
                    return;
                }
                case "pick-agent": {
                    // Selection from the in-chat new-session agent picker.
                    if (typeof message.backend === "string") {
                        const { defaultCwd } = await import("../extension/config");
                        this.d.dialogues.openDialogue(message.backend, { cwd: defaultCwd() }, "New dialogue");
                    }
                    return;
                }
                case "install-agent": {
                    if (typeof message.backend === "string") {
                        const { installCli } = await import("../extension/cli");
                        const adapter = this.d.deps.adapterByBackend.get(message.backend);
                        // The picker only sends this message for a backend that
                        // advertised an installer. Unlike the native QuickPick
                        // flow, its card click is already the user's consent.
                        installCli(message.backend, adapter?.displayName ?? message.backend);
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
                        this.d.dialogues.retryLastMessage(message.index, message.errorMessage);
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
                    if (typeof message.path === "string" && message.path.trim()) {
                        // `~` isn't a real root — path.isAbsolute("~/x") is false,
                        // so an unexpanded tilde would fall into the cwd-relative
                        // branch below and resolve to a bogus <cwd>/~/x path.
                        const raw = message.path.trim().replace(/^~(?=$|[/\\])/, os.homedir());
                        // Paths clicked from free-form message text (e.g. a
                        // file-path mention in an agent reply) are workspace-
                        // relative; tool/attachment-sourced paths are already
                        // absolute and pass through path.isAbsolute unchanged.
                        const cwd = this.d.getController()?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        const resolved = path.isAbsolute(raw) ? raw : (cwd ? path.resolve(cwd, raw) : raw);
                        // vscode.open handles text AND binary (images open in the
                        // image preview), unlike openTextDocument.
                        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(resolved), { preview: true });
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
                case "show-manual": {
                    if (typeof message.manualId === "string" && message.manualId.trim()) {
                        await vscode.commands.executeCommand("symposium.showManual", message.manualId);
                    }
                    return;
                }
                case "show-tool-manual": {
                    await vscode.commands.executeCommand("symposium.showToolManual", message.toolName);
                    return;
                }
                case "file-approve":
                case "file-reject":
                case "file-approve-all":
                case "file-reject-all": {
                    if (await handleChangedFilesMessage(message, this.d)) { return; }
                    return;
                }
                case "refresh-sessions": {
                    const all = await this.d.deps.listSessions();
                    this.d.post({ type: "sessions", items: all.map((s) => ({ ...s, updatedAt: s.updatedAt?.toISOString() })) });
                    return;
                }
                case "session-action":
                case "session-list-backends":
                case "session-switch-backend": {
                    if (await handleSessionMessage(message, this.d)) { return; }
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
