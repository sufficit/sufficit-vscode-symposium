import * as vscode from "vscode";
import { HistoryMessage, SessionInfo, SessionStartOptions } from "../adapters/types";
import { TerminalSession } from "./terminalSession";
import { readWorkspaceBootstrap } from "../config/root";
import { activeEditorContext, isSimpleBrowserOpen } from "./chatSurfaceContext";
import { symposiumLog } from "../extension";
import type { WebviewToHost } from "./protocol";
import { restartFromMessage, retryLastMessage, editResend } from "./surfaceBranching";
import { handleControllerEvent } from "./surfaceDialoguesAttach";
import type { SurfaceDialoguesDeps } from "./surfaceDialoguesTypes";
import { DEFAULT_BUSY_SEND_MODE } from "./sendMode";
import { canonicalReasoning } from "../adapters/reasoning";

/**
 * Dialogue lifecycle for a chat surface: opening a dialogue (new / resumed /
 * handed-off-seed), terminal-backed dialogues, read-only follow mirrors, the
 * restore-on-open and default-start flows, and the branch flows (restart from a
 * message, edit & resend). Extracted from ChatSurface as a collaborator; the
 * surface keeps the actual session state (controller/terminal/follow handle)
 * and exposes it here via getters/setters so the surface stays the owner.
 */
export type { SurfaceDialoguesDeps } from "./surfaceDialoguesTypes";

export class SurfaceDialogues {
    constructor(private readonly d: SurfaceDialoguesDeps) { }

    /**
     * Bumped whenever this surface binds a different dialogue. followSession()
     * awaits history; if another dialogue opens meanwhile, the stale history and
     * tail handle must not attach to the new pane.
     */
    private generation = 0;

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

    /** Starts a new dialogue with Sufficit AI by default, then falls back to any available backend. */
    startDefaultDialogue(): void {
        const backend = this.d.deps.adapterByBackend.has("openai")
            ? "openai"
            : this.d.deps.adapterByBackend.keys().next().value;
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
     * Implemented in surfaceBranching.ts.
     */
    restartFromMessage(index: number): void {
        return restartFromMessage(this.d, (b, o, t, i) => this.openDialogue(b, o, t, i), index);
    }

    /**
     * Plain retry after a transient failure: resends the same text to the
     * CURRENT session, no branching. Implemented in surfaceBranching.ts.
     */
    retryLastMessage(index: number, errorMessage?: string): void {
        return retryLastMessage(this.d, index, errorMessage);
    }

    /**
     * Edit & resend: branch a fresh session seeded with the conversation BEFORE
     * the edited message (anchorIndex excluded), then deliver the edited text as
     * the new message — so we genuinely "restart from this point".
     * Implemented in surfaceBranching.ts.
     */
    editResend(anchorIndex: number, sendMsg: WebviewToHost): void {
        return editResend(this.d, (b, o, t, i) => this.openDialogue(b, o, t, i), anchorIndex, sendMsg);
    }

    /** Opens a stored session (resume) in this surface. */
    openSession(info: SessionInfo): void {
        if (info.continuationBlockedReason) {
            void this.followSession(info, info.continuationBlockedReason);
            return;
        }
        this.openDialogue(
            info.backend,
            { cwd: this.d.deps.cwdFor(info), resumeSessionId: info.sessionId, model: info.model, lineageId: info.lineageId },
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
    async followSession(info: SessionInfo, readOnlyReason?: SessionInfo["continuationBlockedReason"]): Promise<void> {
        const adapter = this.d.deps.adapterByBackend.get(info.backend);
        if (!adapter) { return; }
        if (!adapter.follow && !readOnlyReason) {
            // No live mirror for this backend — fall back to resume.
            this.openSession(info);
            return;
        }
        const generation = ++this.generation;
        this.d.setSendBlockedReason(readOnlyReason ?? "live-follow");
        this.d.detachActive();
        this.d.post({ type: "clear" });
        this.d.post({ type: "history-start" });
        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        this.d.post({
            type: "meta",
            backend: adapter.backend,
            backendName: adapter.displayName,
            modelLabels: adapter.modelLabels?.() ?? {},
            resumed: true,
            historyPending: true,
            readOnly: true,
            readOnlyReason,
            busy: false,
            models: [],
            sessionId: info.sessionId,
            title: info.title,
            sessionsSide,
            chatOnly: this.d.chatOnly,
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", DEFAULT_BUSY_SEND_MODE),
            devMode: vscode.workspace.getConfiguration("symposium.chat").get("devMode", false),
            openIn: vscode.workspace.getConfiguration("symposium.chat").get("openIn", "editor"),
            execDisplay: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
        });
        this.d.activateUsage(adapter);
        if (adapter.history) {
            let messages: HistoryMessage[] | undefined;
            try {
                messages = await adapter.history(info);
            } catch {
                // ignore; live tail still attaches below
            }
            if (generation !== this.generation) {
                return;
            }
            if (messages) {
                this.d.post({ type: "history", messages });
            }
        }
        if (generation !== this.generation) {
            return;
        }
        this.d.post({ type: "history-end" });
        if (!adapter.follow) {
            this.d.deps.lastActive.set({ backend: info.backend, sessionId: info.sessionId });
            this.d.onTitleChange?.(`${info.title} · ${adapter.backend} · read only`);
            return;
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
            this.d.post({ type: "busy", busy: status === "working" });
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
        this.generation++;
        this.d.setSendBlockedReason(undefined);
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
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", DEFAULT_BUSY_SEND_MODE),
            devMode: vscode.workspace.getConfiguration("symposium.chat").get("devMode", false),
            openIn: vscode.workspace.getConfiguration("symposium.chat").get("openIn", "editor"),
            execDisplay: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
        });
        this.d.activateUsage(adapter);
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
        // Write-root guardrail (delivery 1E): scope the agent's writes to the
        // open workspace folders so it can't write across repo boundaries or
        // into files outside the authorized workspace. Empty when no folders
        // are open (no containment, preserving the unrestricted default).
        if (!options.allowedWriteRoots || options.allowedWriteRoots.length === 0) {
            const folders = vscode.workspace.workspaceFolders ?? [];
            if (folders.length) {
                options = { ...options, allowedWriteRoots: folders.map((f) => f.uri.fsPath) };
            } else {
                // No workspace folder open → write containment is off. Surface a
                // notice so the user knows the agent is unrestricted (defect 6.3):
                // a silent unrestricted agent is a footgun.
                this.d.post({ type: "event", event: { kind: "status-notice", text: "No workspace folder open — write-root containment is OFF. The agent can write to any path." } });
            }
        }
        const generation = ++this.generation;
        this.d.setSendBlockedReason(undefined);
        this.d.detachActive();
        this.d.post({ type: "clear" });
        const historyPending = !!options.resumeSessionId;
        if (historyPending) {
            this.d.post({ type: "history-start" });
        }

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
        // Rehydrate the last terminal outcome before the resumed controller is
        // exposed to the sessions list. A reload must not turn a persisted
        // warning/error back into an apparently idle session.
        if (!existing && info?.terminalStatus) {
            controller.attentionStatus = info.terminalStatus;
        }
        // Restore the exact visual for a reopened session: seed the render log
        // (replayed when the sink binds below) so tool rows, diffs, status notices
        // and panels reappear — not just text. Skips lossy history reconstruction.
        const seededVisual = !existing && !!options.resumeSessionId && controller.seedRenderLog();
        this.d.setController(controller);
        void this.d.sync.refreshTasks();   // load this session's tasks into the panel
        void this.d.sync.refreshGuardrails();

        const sessionsSide = vscode.workspace.getConfiguration("symposium.chat").get<string>("sessionsSide", "auto");
        const configuredReasoning = vscode.workspace.getConfiguration("symposium." + adapter.backend).get<string>("reasoning", "default");
        const reasoningMap = adapter.reasoningMap?.();
        const canonicalConfiguredReasoning = reasoningMap ? canonicalReasoning(reasoningMap, configuredReasoning) : configuredReasoning;
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
            historyPending,
            models: adapter.models?.() ?? [],
            reasoningLevels: adapter.reasoningLevels?.() ?? [],
            // "default" means no explicit CLI/API override. Name the underlying
            // adapter default so the picker is informative (default (medium)).
            reasoningDefault: configuredReasoning !== "default"
                ? canonicalConfiguredReasoning
                : (adapter.defaultReasoning?.() ?? "default"),
            modelDefault: vscode.workspace.getConfiguration("symposium." + adapter.backend).get<string>("model", ""),
            pinnedModels: this.d.deps.modelPrefs.getPinned(adapter.backend),
            // Last model used in this session (resume), so the picker restores it
            // instead of defaulting to the first discovered model.
            sessionModel: controller.getModel() || info?.model || "",
            // Attach-browser-page button only shows when a Simple Browser is open.
            browserOpen: isSimpleBrowserOpen(),
            // Per-session tool gating for the native AI backend (undefined for CLIs).
            aiTools: controller.aiToolsInfo?.(),
            // Real busy state (resets a stuck "thinking" compose on reopen).
            busy: controller.isBusy,
            permissionModes: adapter.permissionModes?.() ?? [],
            permission: adapter.defaultPermission?.() ?? "default",
            sessionId: controller.sessionKey ?? controller.sessionId,
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
            whenBusy: vscode.workspace.getConfiguration("symposium.chat").get("whenBusy", DEFAULT_BUSY_SEND_MODE),
            devMode: vscode.workspace.getConfiguration("symposium.chat").get("devMode", false),
            openIn: vscode.workspace.getConfiguration("symposium.chat").get("openIn", "editor"),
            execDisplay: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
        });
        this.d.activateUsage(adapter);
        this.d.setControllerDetach(controller.attach((message) => handleControllerEvent(this.d, backend, message)));
        if (!existing && info && !seededVisual) {
            void controller.loadHistory(info).finally(() => {
                if (generation === this.generation) {
                    this.d.post({ type: "history-end" });
                }
            });
        } else if (historyPending) {
            // Existing controllers and persisted visual logs replay
            // synchronously during attach(), so their tail is ready now.
            this.d.post({ type: "history-end" });
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
