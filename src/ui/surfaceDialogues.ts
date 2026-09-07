import * as vscode from "vscode";
import { HistoryMessage, SessionInfo, SessionStartOptions } from "../adapters/types";
import { readWorkspaceBootstrap } from "../config/root";
import { activeEditorContext, isSimpleBrowserOpen } from "./chatSurfaceContext";
import type { WebviewToHost } from "../protocol/chat";
import { restartFromMessage, retryLastMessage, editResend } from "./surfaceBranching";
import { handleControllerSideEffect } from "./surfaceDialoguesAttach";
import type { SurfaceDialoguesDeps } from "./surfaceDialoguesTypes";
import { DEFAULT_BUSY_SEND_MODE } from "../protocol/sendMode";
import { canonicalReasoning } from "../adapters/reasoning";
import {
    openTerminalDialogue as openTerminalDialogueFlow,
    type TerminalDialogueOptions,
} from "./surfaceTerminalDialogue";
import {
    restoreOrStart as restoreOrStartFlow,
    startDefaultDialogue as startDefaultDialogueFlow,
} from "./surfaceDialoguesStartup";
import { ensureAllowedWriteRoots } from "./surfaceWriteRoots";

/** Coordinates new, resumed, terminal-backed and read-only dialogues. */
export type { SurfaceDialoguesDeps } from "./surfaceDialoguesTypes";

export class SurfaceDialogues {
    constructor(private readonly d: SurfaceDialoguesDeps) {}

    /** Prevents an awaited follow operation from attaching to a newer dialogue. */
    private generation = 0;

    /**
     * Restores the last active session on open, or starts a default dialogue.
     * Implemented in surfaceDialoguesStartup.ts.
     */
    restoreOrStart(): Promise<void> {
        return restoreOrStartFlow(
            this.d,
            (info) => this.openSession(info),
            () => this.startDefaultDialogue(),
        );
    }

    /**
     * Starts a new dialogue with Sufficit AI by default, then falls back to any
     * available backend. Implemented in surfaceDialoguesStartup.ts.
     */
    startDefaultDialogue(): void {
        return startDefaultDialogueFlow(this.d, (b, o, t) => this.openDialogue(b, o, t));
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
    retryLastMessage(index: number, errorMessage?: string, expectedText?: string): void {
        return retryLastMessage(this.d, index, errorMessage, expectedText);
    }

    /**
     * Edit & resend: branch a fresh session seeded with the conversation BEFORE
     * the edited message (anchorIndex excluded), then deliver the edited text as
     * the new message — so we genuinely "restart from this point".
     * Implemented in surfaceBranching.ts.
     */
    editResend(anchorIndex: number, sendMsg: WebviewToHost): void {
        return editResend(
            this.d,
            (b, o, t, i) => this.openDialogue(b, o, t, i),
            anchorIndex,
            sendMsg,
        );
    }

    /** Opens a stored session (resume) in this surface. */
    openSession(info: SessionInfo): void {
        if (info.continuationBlockedReason) {
            void this.followSession(info, info.continuationBlockedReason);
            return;
        }
        this.openDialogue(
            info.backend,
            {
                cwd: this.d.deps.cwdFor(info),
                resumeSessionId: info.sessionId,
                model: info.model,
                reasoning: info.reasoning,
                lineageId: info.lineageId,
            },
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
    async followSession(
        info: SessionInfo,
        readOnlyReason?: SessionInfo["continuationBlockedReason"],
    ): Promise<void> {
        const adapter = this.d.deps.adapterByBackend.get(info.backend);
        if (!adapter) {
            return;
        }
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
        const sessionsSide = vscode.workspace
            .getConfiguration("symposium.chat")
            .get<string>("sessionsSide", "auto");
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
            whenBusy: vscode.workspace
                .getConfiguration("symposium.chat")
                .get("whenBusy", DEFAULT_BUSY_SEND_MODE),
            canSteerInline: adapter.supportsInlineSteer?.() === true,
            devMode: vscode.workspace.getConfiguration("symposium.chat").get("devMode", false),
            openIn: vscode.workspace.getConfiguration("symposium.chat").get("openIn", "editor"),
            execDisplay: vscode.workspace
                .getConfiguration("symposium.openai")
                .get<string>("shellExecution", "silent"),
        });
        this.d.activateUsage(adapter);
        if (adapter.history) {
            let messages: HistoryMessage[] | undefined;
            try {
                messages = (await adapter.history(info)).messages;
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
    openTerminalDialogue(backend: string, options: TerminalDialogueOptions, title: string): void {
        this.generation++;
        openTerminalDialogueFlow(this.d, backend, options, title);
    }

    /**
     * Opens a dialogue (new or resumed) in this surface. Switching away from a
     * running session DETACHES it (it keeps working in the background) instead
     * of stopping it; returning to it re-attaches and replays its output.
     */
    openDialogue(
        backend: string,
        options: SessionStartOptions,
        title: string,
        info?: SessionInfo,
    ): void {
        const adapter = this.d.deps.adapterByBackend.get(backend);
        if (!adapter) {
            return;
        }
        options = ensureAllowedWriteRoots(options, this.d.post);
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
                options = {
                    ...options,
                    systemPrompt: options.systemPrompt
                        ? options.systemPrompt + "\n\n" + langHint
                        : langHint,
                };
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
        // A persisted terminal outcome belongs to the previous interaction.
        // Opening/resuming the session acknowledges it; only a failure from the
        // current controller should produce the live red status indicator.
        // Restore persisted internal events before rebuilding the authoritative
        // AHP projection for a reopened session.
        const seededVisual = !existing && !!options.resumeSessionId && controller.seedRenderLog();
        if (seededVisual && controller.sessionKey) {
            this.d.deps.ahp.rebuild(backend, controller.sessionKey);
        }
        this.d.setController(controller);
        void this.d.sync.refreshTasks(); // load this session's tasks into the panel
        void this.d.sync.refreshGuardrails();

        const sessionsSide = vscode.workspace
            .getConfiguration("symposium.chat")
            .get<string>("sessionsSide", "auto");
        const configuredReasoning = vscode.workspace
            .getConfiguration("symposium." + adapter.backend)
            .get<string>("reasoning", "default");
        const reasoningMap = adapter.reasoningMap?.();
        const canonicalConfiguredReasoning = reasoningMap
            ? canonicalReasoning(reasoningMap, configuredReasoning)
            : configuredReasoning;
        this.d.post({
            type: "meta",
            backend: adapter.backend,
            backendName: adapter.displayName,
            modelLabels: adapter.modelLabels?.() ?? {},
            // Inline badge for an agent-def-bound dialogue (once, first turn; null = plain). See SessionStartOptions.
            agentLabels: options.agentName
                ? {
                      agent: options.agentName,
                      toolsDeclared: options.toolsDeclared ?? [],
                      toolsAllowed: options.toolsAllowed ?? [],
                  }
                : null,
            bootstrapLink: bootstrapLink ?? null, // per-workspace bootstrap link (null = none)
            resumed: !!options.resumeSessionId,
            historyPending,
            models: adapter.models?.() ?? [],
            reasoningLevels: adapter.reasoningLevels?.() ?? [],
            // "default" means no explicit CLI/API override. Name the underlying
            // adapter default so the picker is informative (default (medium)).
            reasoningDefault:
                configuredReasoning !== "default"
                    ? canonicalConfiguredReasoning
                    : (adapter.defaultReasoning?.() ?? "default"),
            // Built-in defaults live under symposium.<backend>.model; custom
            // adapters keep theirs in symposium.adapters[].model. Read through
            // the shared preference store so the picker reflects either kind.
            modelDefault: this.d.deps.modelPrefs.getDefault(adapter.backend),
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
            permissionDefault: adapter.defaultPermission?.() ?? "default",
            // Show the policy the live controller actually enforces. Using the
            // adapter default here made resumed manager/user sessions look like
            // admin even while an approval prompt was correctly pending.
            permission: controller.getPermission() || adapter.defaultPermission?.() || "default",
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
            whenBusy: vscode.workspace
                .getConfiguration("symposium.chat")
                .get("whenBusy", DEFAULT_BUSY_SEND_MODE),
            canSteerInline: adapter.supportsInlineSteer?.() === true,
            devMode: vscode.workspace.getConfiguration("symposium.chat").get("devMode", false),
            openIn: vscode.workspace.getConfiguration("symposium.chat").get("openIn", "editor"),
            execDisplay: vscode.workspace
                .getConfiguration("symposium.openai")
                .get<string>("shellExecution", "silent"),
        });
        this.d.activateUsage(adapter);
        const ahpDetach = this.d.bindAhp(backend, controller);
        const sideEffectDetach = controller.subscribeLive((message) =>
            handleControllerSideEffect(this.d, backend, message),
        );
        this.d.setControllerDetach(() => {
            sideEffectDetach();
            ahpDetach?.();
        });
        if (info && (existing || !seededVisual || ahpDetach)) {
            // In AHP mode the webview renders ChatState.turns, which are only
            // populated by the {type:"history"} envelope that loadHistory emits
            // (projectionRuntime.onMessage → chat/turnsLoaded). The seeded visual
            // log does not produce a history envelope for the AHP runtime, so sessions
            // opened with a persisted render log would otherwise show no turns.
            //
            // Re-sync the projection runtime so the just-created controller appears
            // in source.list() and gets an AHP record before the history
            // envelope is emitted — otherwise the projection has no observer and the
            // turns are silently dropped.
            this.d.deps.ahp.sync();
            // A live controller can outlive its webview while its restored AHP
            // channel is empty/stale. Re-project authoritative history on every
            // reopen; when the stream is already seeded, keep that derived page
            // transient so it cannot duplicate the persisted render ledger.
            void controller.loadHistory(info, !!existing || seededVisual).finally(() => {
                if (generation === this.generation) {
                    this.d.post({ type: "history-end" });
                }
            });
        } else if (historyPending) {
            // Existing controllers already have an AHP snapshot, so their tail is ready now.
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
