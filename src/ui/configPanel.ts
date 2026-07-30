import * as vscode from "vscode";
import { ensureScaffold, rootDir, readToolCredential } from "../config/root";
import { renderConfigHtml } from "./configHtml";
import { tr } from "./configI18n";
import { listServers, ensureSufficitNativeServer } from "../config/servers";
import { getSttState, downloadSttModel, deleteSttModel } from "../voice/sttService";
import { removeLegacySufficitToolImports } from "../config/importResources";
import { handleCompressionMessage } from "./configCompressionHandler";
import { handleBackendsMessage } from "./configBackendsHandler";
import { handleMcpMessage } from "./configMcpHandler";
import { handleResourcesMessage } from "./configResourcesHandler";
import { handleVoiceMessage } from "./configVoiceHandler";
import type { ConfigPanelDeps, ConfigMessage, ConfigHandlerCtx } from "./configTypes";
export type { ConfigPanelDeps, ConfigMessage, ConfigHandlerCtx } from "./configTypes";

/**
 * Dynamic configuration surface: a reusable webview panel that lists the local
 * vendor-neutral agent knowledge (~/.symposium/repo), lets the user edit/test
 * backends, and shows the sync/health of the sufficit-ai memory hub. All
 * reads/writes go through the SymposiumApi facade so the panel and the remote
 * bridge stay in lock-step.
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

    private constructor(private readonly context: vscode.ExtensionContext, private readonly deps: ConfigPanelDeps) {
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
        // Delegate cohesive case groups to sibling handlers (disjoint case sets).
        const ctx: ConfigHandlerCtx = {
            api,
            auth: this.deps.auth,
            chatView: this.deps.chatView,
            context: this.context,
            tr: (k, v) => this.tr(k, v),
            pushState: () => this.pushState(),
            post: (m) => { void this.panel.webview.postMessage(m); },
            offerReload: (m) => this.offerReload(m),
        };
        if (await handleCompressionMessage(message, ctx)) { return; }
        if (await handleBackendsMessage(message, ctx)) { return; }
        if (await handleMcpMessage(message, ctx)) { return; }
        if (await handleResourcesMessage(message, ctx)) { return; }
        if (await handleVoiceMessage(message, ctx)) { return; }

        switch (message.type) {
            case "ready":
                await this.pushState();
                return;
            case "refresh": {
                // Re-render + live-probe the hub so the button gives real feedback.
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
                    else if (message.key.endsWith("turnSilenceMinutes")) { value = Math.max(0, Number(message.value) || 0); }
                    else if (message.key.endsWith("noProgressStop")) { value = Math.max(0, Number(message.value) || 0); }
                    else if (message.key.endsWith("autoCompactAt")) { value = Math.min(1, Math.max(0, Number(message.value) || 0)); }
                    else if (message.key.endsWith("autoCompactOnTasksComplete")) { value = message.value === "true"; }
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
                    else if (message.key === "symposium.chat.devMode") {
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
            case "remote-access":
                await vscode.commands.executeCommand("symposium.showRemoteAccess");
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
            case "open-setting-json": {
                if (typeof message.key === "string") {
                    await (await import("./userSettings")).openUserSettingAt(this.context, message.key);
                }
                return;
            }
            case "set-vscode-config": {
                if (typeof message.key === "string") {
                    let value: unknown = message.value;
                    if (value === "true") { value = true; }           // checkbox
                    else if (value === "false") { value = false; }
                    else if (message.key.startsWith("macos.mouse.")) { value = Number(message.value) || 0; }
                    try {
                        await vscode.workspace.getConfiguration().update(message.key, value, vscode.ConfigurationTarget.Global);
                    } catch {
                        // Third-party keys (gitlens.*, github.copilot.*) aren't registered
                        // here, so update() throws — write settings.json directly instead.
                        const { writeUserSetting } = await import("./userSettings");
                        writeUserSetting(this.context, message.key, value);
                    }
                }
                return;
            }
        }
    }

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
        // OS-keyring persistence (drives the Sufficit-tab fallback-creds banner).
        const secretStorageWorking = this.deps.auth ? await this.deps.auth.isSecretStorageWorking().catch(() => true) : true;

        // Network status: bridge, relay, VPN (Tailscale) — for the Sufficit tab.
        const bridgeCfg = vscode.workspace.getConfiguration("symposium.bridge");
        const { getJoinedHostname, checkTailscaleStatus } = await import("../net/tailnet");
        const { getMachineId } = await import("../net/relayClient");
        // Try the module-level cache first; if empty, check Tailscale directly
        // (ensureTailnetJoined may not have run, e.g. not logged in to Sufficit).
        let vpnHostname = getJoinedHostname();
        if (!vpnHostname) {
            const ts = await checkTailscaleStatus();
            if (ts?.BackendState === "Running" && ts.Self?.HostName) {
                vpnHostname = ts.Self.HostName;
            }
        }
        const machineId = getMachineId();
        const bridgeEnabled = bridgeCfg.get<boolean>("enabled", false);
        const relayMode = bridgeCfg.get<string>("relay", "auto");
        // Session cache RAM
        let sessionCacheRam = 0;
        let sessionCacheCount = 0;
        try {
            const mod = await import("../extension");
            if (mod.sessionIndex) {
                sessionCacheRam = mod.sessionIndex.memoryUsageBytes() ?? 0;
                sessionCacheCount = mod.sessionIndex.listCached()?.length ?? 0;
            }
        } catch { /* not ready */ }
        const networkInfo = {
            sessionCacheRam,
            sessionCacheCount,
            bridgeEnabled,
            bridgePort: bridgeCfg.get<number>("port", 47600),
            relayMode,
            relayMachineId: machineId,
            relayPublicUrl: bridgeEnabled ? `https://ai.sufficit.com.br/symposium?machineId=${machineId}` : undefined,
            vpnConnected: !!vpnHostname,
            vpnHostname: vpnHostname ?? undefined,
        };

        if (profile) {   // ensure the Sufficit native MCP server exists when logged in
            try {
                ensureSufficitNativeServer();
                removeLegacySufficitToolImports();
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
            // Vault bindings: tools with a credentialRef (resolved via vault/hub).
            vaultBindings: (api.resources.scan()["tool"] || [])
                .map(t => ({ tool: t.name, ...readToolCredential(t.name) }))
                .filter(vb => vb.ref),
            mcpServers: listServers(),
            // A failing backends list must not abort the whole refresh.
            backends: await api.backends.list().catch(() => []),
            // Live hub liveness (status().health goes stale after a failed sync).
            sync: api.sync.configured()
                ? { ...api.sync.status(), health: (await api.sync.health().catch(() => false)) ? "ok" as const : "down" as const }
                : api.sync.status(),
            hubConfigured: api.sync.configured(),
            profile: profile ?? null,
            secretStorageWorking,
            prefs: {
                sessionsSide: chat.get<string>("sessionsSide", "auto"),
                openIn: chat.get<string>("openIn", "editor"),
                preferredLanguage: chat.get<string>("preferredLanguage", ""),
                systemInstruction: chat.get<string>("systemInstruction", ""),
                // No default arg: get() returns the package.json default so the
                // textarea shows the built-in hint; a cleared field ("") stays "".
                memoryInstruction: chat.get<string>("memoryInstruction"),
                lmTools: root.get<string>("lmTools", "off"),
                turnSilenceMinutes: root.get<number>("turnSilenceMinutes", 5),
                maxToolHops: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxToolHops", 50),
                noProgressStop: vscode.workspace.getConfiguration("symposium.openai").get<number>("noProgressStop", 0),
                autoCompactAt: vscode.workspace.getConfiguration("symposium.openai").get<number>("autoCompactAt", 0.8),
                autoCompactOnTasksComplete: vscode.workspace.getConfiguration("symposium.openai").get<boolean>("autoCompactOnTasksComplete", true),
                maxHistoryMessages: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxHistoryMessages", 40),
                timeGapNotice: vscode.workspace.getConfiguration("symposium.openai").get<string>("timeGapNotice", "5m"),
                devMode: chat.get<boolean>("devMode", false),
                shellExecution: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
                autoApprove: vscode.workspace.getConfiguration().get<boolean>("chat.tools.global.autoApprove", false),
                voiceLanguage: root.get<string>("voice.language", "pt-BR"),
                voiceContinuous: root.get<boolean>("voice.continuous", true),
                voiceInterimResults: root.get<boolean>("voice.interimResults", true),
                voiceDotsAnimation: root.get<boolean>("voice.dotsAnimation", true),
                voiceSoundFeedback: root.get<boolean>("voice.soundFeedback", true),
            },
            // Symposium's own commit-message keys (registered, so getConfiguration
            // reads them). git.* / macos.* stay as third-party. tp() reads any raw
            // settings.json key (getConfiguration returns "" for unregistered ones).
            vscodeConfig: {
                "symposium.commit.preset": vscode.workspace.getConfiguration("symposium.commit").get<string>("preset", ""),
                "symposium.commit.origin": vscode.workspace.getConfiguration("symposium.commit").get<string>("origin", ""),
                "git.enableSmartCommit": vscode.workspace.getConfiguration("git").get<boolean>("enableSmartCommit", true),
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
            networkInfo,
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
