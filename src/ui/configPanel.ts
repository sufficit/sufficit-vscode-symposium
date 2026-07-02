import * as vscode from "vscode";
import { ensureScaffold, ResourceKind, rootDir, readToolCredential } from "../config/root";
import { SymposiumApi } from "../api/symposiumApi";
import { SufficitAuth } from "../auth/identity";
import { renderConfigHtml } from "./configHtml";
import { tr } from "./configI18n";
import { listServers, ensureSufficitNativeServer } from "../config/servers";
import { getSttState, downloadSttModel, deleteSttModel } from "../voice/sttService";
import { handleCompressionMessage } from "./configCompressionHandler";
import { handleBackendsMessage } from "./configBackendsHandler";
import { handleMcpMessage, McpFormPayload } from "./configMcpHandler";
import { handleResourcesMessage } from "./configResourcesHandler";

export interface ConfigPanelDeps {
    api: SymposiumApi;
    auth?: SufficitAuth;
}

/** Shape of the messages dispatched from the config webview to the host. */
export interface ConfigMessage {
    type: string;
    path?: string;
    kind?: ResourceKind;
    name?: string;
    backend?: string;
    value?: string;
    key?: string;
    modelId?: string;
    payload?: McpFormPayload & { name?: string; server?: string; itemType?: string };
}

/**
 * Context surface handed to the extracted config*Handler modules. Each handler
 * is a free function over this interface (mirroring controllerMessageHandler),
 * so the case bodies move verbatim with only `this.X` → `ctx.X` rewrites.
 */
export interface ConfigHandlerCtx {
    api: SymposiumApi;
    /** Resolve a localized string. */
    tr(key: string, vars?: Record<string, string | number>): string;
    /** Re-push the full panel state to the webview. */
    pushState(): Promise<void>;
    /** Post a raw message to the webview (used for back-compression presets, ollama list, stt progress). */
    post(message: object): void;
    /** Confirms a CRUD change and offers a reload. */
    offerReload(message: string): Promise<void>;
}

/**
 * Dynamic configuration surface: a reusable webview panel that lists the local
 * vendor-neutral agent knowledge (~/.symposium/repo), lets the user edit/test
 * backends (health + model + executable), and shows the sync/health of the
 * sufficit-ai memory hub. Replaces the static settings.json flow.
 *
 * All reads/writes go through the SymposiumApi facade, so the panel and the
 * remote bridge stay in lock-step.
 *
 * The giant `onMessage` switch is split across three sibling handler modules
 * (compression / backends / mcp); this class keeps the small/frequent cases and
 * the shared state machinery.
 */
export class ConfigPanel {
    private static current: ConfigPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    static show(context: vscode.ExtensionContext, deps: ConfigPanelDeps): ConfigPanel {
        if (ConfigPanel.current) {
            ConfigPanel.current.panel.reveal();
            return ConfigPanel.current;
        }
        ConfigPanel.current = new ConfigPanel(context, deps);
        return ConfigPanel.current;
    }

    /** Re-pushes state to the open panel (e.g. after login/logout). */
    static refresh(): void {
        void ConfigPanel.current?.pushState();
    }

    private constructor(context: vscode.ExtensionContext, private readonly deps: ConfigPanelDeps) {
        ensureScaffold();
        this.panel = vscode.window.createWebviewPanel(
            "symposium.config",
            this.tr("config.title"),
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = renderConfigHtml(this.resolveLang());
        this.panel.webview.onDidReceiveMessage(
            (m) => { void this.onMessage(m).catch((e) => void vscode.window.showErrorMessage(this.tr("msg.config.actionFailed", { error: String((e && e.message) || e) }))); },
            undefined, this.disposables);

        // Live refresh when repo files change on disk.
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(rootDir()), "repo/**"));
        watcher.onDidCreate(() => this.pushState(), undefined, this.disposables);
        watcher.onDidChange(() => this.pushState(), undefined, this.disposables);
        watcher.onDidDelete(() => this.pushState(), undefined, this.disposables);
        this.disposables.push(watcher);

        this.panel.onDidDispose(() => this.dispose(), undefined, context.subscriptions);
    }

    private resolveLang(): string {
        const c = vscode.workspace.getConfiguration("symposium.chat");
        return (c.get<string>("preferredLanguage", "").trim() || vscode.env.language || "en").toLowerCase();
    }

    private tr(key: string, vars?: Record<string, string | number>): string {
        return tr(this.resolveLang(), key, vars);
    }

    private async onMessage(message: ConfigMessage): Promise<void> {
        const api = this.deps.api;
        // Delegate the big cohesive case groups to sibling handlers (each
        // returns true when it handled the message). Order doesn't matter — the
        // case sets are disjoint.
        const ctx: ConfigHandlerCtx = {
            api,
            tr: (k, v) => this.tr(k, v),
            pushState: () => this.pushState(),
            post: (m) => { void this.panel.webview.postMessage(m); },
            offerReload: (m) => this.offerReload(m),
        };
        if (await handleCompressionMessage(message, ctx)) { return; }
        if (await handleBackendsMessage(message, ctx)) { return; }
        if (await handleMcpMessage(message, ctx)) { return; }
        if (await handleResourcesMessage(message, ctx)) { return; }

        switch (message.type) {
            case "ready":
                await this.pushState();
                return;
            case "refresh": {
                // Re-render AND live-probe the hub so the button gives real
                // feedback (it used to silently re-render with no notification).
                await this.pushState();
                let msg = this.tr("msg.config.refreshed");
                if (api.sync.configured()) {
                    const ok = await api.sync.health().catch(() => false);
                    msg = this.tr(ok ? "msg.config.refreshed.hubUp" : "msg.config.refreshed.hubDown");
                }
                void vscode.window.showInformationMessage(msg);
                return;
            }
            case "test-backend":
                if (message.backend) {
                    const s = await api.backends.test(message.backend);
                    void vscode.window.showInformationMessage(
                        s ? (s.available
                            ? this.tr("msg.testBackend.ok", { backend: message.backend, detail: s.detail })
                            : this.tr("msg.testBackend.unavailable", { backend: message.backend, detail: s.detail }))
                            : this.tr("msg.testBackend.unknown", { backend: message.backend }));
                    await this.pushState();
                }
                return;
            case "edit-backend": {
                const b = message.backend ?? "";
                const cli = b === "claude" || b === "codex" || b === "copilot";
                if (cli) {
                    // CLI backend: its executable/model/etc live in settings.
                    await vscode.commands.executeCommand("workbench.action.openSettings", "symposium." + b);
                } else if (b === "openai") {
                    // Built-in Sufficit AI backend lives under symposium.openai.*.
                    await vscode.commands.executeCommand("workbench.action.openSettings", "symposium.openai");
                } else {
                    // Custom OpenAI-compatible endpoint: edit the adapters JSON directly.
                    await vscode.commands.executeCommand("symposium.editAdapters");
                }
                return;
            }
            case "set-model":
                if (message.backend !== undefined) {
                    await api.backends.setModel(message.backend, message.value ?? "");
                    await this.pushState();
                }
                return;
            case "set-executable":
                if (message.backend !== undefined) {
                    await api.backends.setExecutable(message.backend, message.value ?? "");
                    await this.pushState();
                }
                return;
            case "config-hub":
                await vscode.commands.executeCommand("workbench.action.openSettings", "symposium.hub");
                return;
            case "set-pref":
                if (typeof message.key === "string") {
                    // Coerce by key: numbers for hops, booleans for autoApprove and voice options.
                    let value: unknown = message.value;
                    if (message.key.endsWith("maxToolHops")) { value = Math.max(1, Number(message.value) || 50); }
                    else if (message.key.endsWith("noProgressStop")) { value = Math.max(0, Number(message.value) || 0); }
                    else if (message.key.endsWith("autoCompactAt")) { value = Math.min(1, Math.max(0, Number(message.value) || 0)); }
                    else if (message.key.endsWith("maxHistoryMessages")) { value = Math.max(0, Number(message.value) || 0); }
                    else if (message.key === "chat.tools.global.autoApprove") {
                        value = message.value === "true";
                        // optIn must be on for the global flag to take effect.
                        await vscode.workspace.getConfiguration().update("chat.tools.global.autoApprove.optIn", true, vscode.ConfigurationTarget.Global);
                    }
                    else if (message.key === "symposium.voice.continuous") {
                        value = message.value === "true";
                    }
                    else if (message.key === "symposium.voice.interimResults") {
                        value = message.value === "true";
                    }
                    else if (message.key === "symposium.voice.dotsAnimation") {
                        value = message.value === "true";
                    }
                    else if (message.key === "symposium.voice.soundFeedback") {
                        value = message.value === "true";
                    }
                    else if (message.key === "symposium.voice.whisper.translate" || message.key === "symposium.voice.fasterWhisper.vad") {
                        value = message.value === "true";
                    }
                    else if (message.key === "symposium.voice.whisper.threads") { value = Math.max(1, Number(message.value) || 4); }
                    else if (message.key === "symposium.voice.whisper.beamSize" || message.key === "symposium.voice.fasterWhisper.beamSize") { value = Math.max(1, Number(message.value) || 5); }
                    else if (message.key === "symposium.voice.whisper.temperature") { value = Math.min(1, Math.max(0, Number(message.value) || 0)); }
                    await vscode.workspace.getConfiguration().update(message.key, value, vscode.ConfigurationTarget.Global);
                    await this.pushState();
                }
                return;
            case "login":
                await vscode.commands.executeCommand("symposium.login");
                await this.pushState();
                return;
            case "logout":
                await vscode.commands.executeCommand("symposium.logout");
                await this.pushState();
                return;
            case "sync-pull": {
                const r = await api.sync.pull();
                this.report(this.tr("msg.sync.label.pull"), r);
                await this.pushState();
                return;
            }
            case "sync-push": {
                const r = await api.sync.push();
                this.report(this.tr("msg.sync.label.push"), r);
                await this.pushState();
                return;
            }
            case "stt-download-model": {
                const id = message.modelId;
                if (!id) { return; }
                this.panel.webview.postMessage({ type: "stt-progress", modelId: id, ratio: 0, phase: "start" });
                try {
                    await downloadSttModel(id, (p) => {
                        void this.panel.webview.postMessage({ type: "stt-progress", modelId: id, ratio: p.ratio, received: p.received, total: p.total, phase: "downloading" });
                    });
                    void vscode.window.showInformationMessage(this.tr("msg.stt.downloaded", { model: id }));
                } catch (e) {
                    void vscode.window.showErrorMessage(this.tr("msg.stt.downloadFailed", { model: id, error: String((e && (e as Error).message) || e) }));
                } finally {
                    this.panel.webview.postMessage({ type: "stt-progress", modelId: id, ratio: 1, phase: "done" });
                    await this.pushState();
                }
                return;
            }
            case "stt-delete-model": {
                const id = message.modelId;
                if (!id) { return; }
                const removed = deleteSttModel(id);
                if (removed) { void vscode.window.showInformationMessage(this.tr("msg.stt.deleted", { model: id })); }
                await this.pushState();
                return;
            }
            case "set-vscode-config": {
                if (typeof message.key === "string") {
                    let value: unknown = message.value;
                    // Handle boolean values for checkboxes
                    if (value === "true") { value = true; }
                    else if (value === "false") { value = false; }
                    // Handle numeric values for macOS mouse settings
                    else if (message.key.startsWith("macos.mouse.")) {
                        value = Number(message.value) || 0;
                    }
                    await vscode.workspace.getConfiguration().update(message.key, value, vscode.ConfigurationTarget.Global);
                }
                return;
            }
        }
    }

    /** Confirms a CRUD change and offers a reload (added/removed endpoints register on reload). */
    private async offerReload(message: string): Promise<void> {
        const reload = this.tr("msg.reloadWindow.action");
        const pick = await vscode.window.showInformationMessage(message, reload);
        if (pick === reload) {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
    }

    private report(label: string, r: { pushed: number; pulled: number; skipped: number; errors: string[] }): void {
        if (r.errors.length) {
            void vscode.window.showWarningMessage(
                this.tr("msg.sync.report.error", { label, errors: r.errors.join(" · ") }));
            return;
        }
        void vscode.window.showInformationMessage(
            this.tr("msg.sync.report.success", { label, pulled: r.pulled, pushed: r.pushed, skipped: r.skipped }));
    }

    private async pushState(): Promise<void> {
        const api = this.deps.api;
        const profile = this.deps.auth ? await this.deps.auth.getProfile().catch(() => undefined) : undefined;

        // Ensure Sufficit native MCP server exists when logged in
        if (profile) {
            try {
                ensureSufficitNativeServer();
            } catch (e) {
                console.error("Failed to ensure Sufficit native MCP server:", e);
            }
        }
        const chat = vscode.workspace.getConfiguration("symposium.chat");
        const root = vscode.workspace.getConfiguration("symposium");
        const { CompressionManager } = await import("../compression");
        const compressionManager = CompressionManager.getInstance();
        const state = {
            root: api.resources.root(),
            resources: api.resources.scan(),
            // Vault bindings: tools that declare a credentialRef (secret resolved
            // at runtime via the Sufficit vault / hub API).
            vaultBindings: (api.resources.scan()["tool"] || [])
                .map(t => ({ tool: t.name, ...readToolCredential(t.name) }))
                .filter(vb => vb.ref),
            // MCP servers (Model Context Protocol)
            mcpServers: listServers(),
            // A failing backends list (e.g. the gateway rejecting a stale token)
            // must not abort the whole refresh — render the rest of the panel.
            backends: await api.backends.list().catch(() => []),
            sync: api.sync.status(),
            hubConfigured: api.sync.configured(),
            profile: profile ?? null,
            prefs: {
                sessionsSide: chat.get<string>("sessionsSide", "auto"),
                openIn: chat.get<string>("openIn", "editor"),
                preferredLanguage: chat.get<string>("preferredLanguage", ""),
                systemInstruction: chat.get<string>("systemInstruction", ""),
                memoryInstruction: (() => {
                    const insp = chat.inspect<string>("memoryInstruction");
                    if (!insp) { return ""; }
                    // Use the default from package.json when the user hasn't set
                    // an explicit value (globalValue/workspaceValue). This makes
                    // the default visible in the textarea.
                    if (insp.globalValue !== undefined) { return insp.globalValue; }
                    if (insp.workspaceValue !== undefined) { return insp.workspaceValue; }
                    return insp.defaultValue ?? "";
                })(),
                lmTools: root.get<string>("lmTools", "terminal"),
                maxToolHops: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxToolHops", 50),
                noProgressStop: vscode.workspace.getConfiguration("symposium.openai").get<number>("noProgressStop", 0),
                autoCompactAt: vscode.workspace.getConfiguration("symposium.openai").get<number>("autoCompactAt", 0.8),
                maxHistoryMessages: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxHistoryMessages", 40),
                shellExecution: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
                autoApprove: vscode.workspace.getConfiguration().get<boolean>("chat.tools.global.autoApprove", false),
                // Voice input preferences
                voiceLanguage: root.get<string>("voice.language", "pt-BR"),
                voiceContinuous: root.get<boolean>("voice.continuous", true),
                voiceInterimResults: root.get<boolean>("voice.interimResults", true),
                voiceDotsAnimation: root.get<boolean>("voice.dotsAnimation", true),
                voiceSoundFeedback: root.get<boolean>("voice.soundFeedback", true),
            },
            // VS Code global settings (safeguarded for when extensions aren't installed)
            vscodeConfig: {
                "gitlens.ai.model": vscode.workspace.getConfiguration("gitlens.ai").get<string>("model", ""),
                "gitlens.ai.vscode.model": vscode.workspace.getConfiguration("gitlens.ai.vscode").get<string>("model", ""),
                "gitlens.ai.ollama.url": vscode.workspace.getConfiguration("gitlens.ai.ollama").get<string>("url", ""),
                "github.copilot.chat.askAgent.model": vscode.workspace.getConfiguration("github.copilot.chat").get<string>("askAgent.model", ""),
                "github.copilot.chat.implementAgent.model": vscode.workspace.getConfiguration("github.copilot.chat").get<string>("implementAgent.model", ""),
                "git.enableSmartCommit": vscode.workspace.getConfiguration("git").get<boolean>("enableSmartCommit", true),
                // macOS-specific settings (safe to read even if not on macOS)
                "macos.mouse.trackingSpeed": vscode.workspace.getConfiguration("macos.mouse").get<number>("trackingSpeed", 0)?.toString() || "",
                "macos.mouse.scrollingSpeed": vscode.workspace.getConfiguration("macos.mouse").get<number>("scrollingSpeed", 0)?.toString() || "",
                "macos.mouse.doubleClickSpeed": vscode.workspace.getConfiguration("macos.mouse").get<number>("doubleClickSpeed", 0)?.toString() || "",
            },
            compression: {
                presets: compressionManager.getPresets(),
                defaultPresetId: compressionManager.getDefaultPresetId(),
                perSessionEnabled: compressionManager.isPerSessionEnabled(),
            },
            // Local speech-to-text engines, models (with installed flag) and tool availability.
            stt: await getSttState().catch(() => null),
        };
        await this.panel.webview.postMessage({ type: "state", state });
    }

    private dispose(): void {
        ConfigPanel.current = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
