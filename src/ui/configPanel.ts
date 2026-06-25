import * as vscode from "vscode";
import { ensureScaffold, ResourceKind, rootDir } from "../config/root";
import { AdapterPatch, SymposiumApi } from "../api/symposiumApi";
import { SufficitAuth } from "../auth/identity";
import { renderConfigHtml } from "./configHtml";

export interface ConfigPanelDeps {
    api: SymposiumApi;
    auth?: SufficitAuth;
}

/**
 * Dynamic configuration surface: a reusable webview panel that lists the local
 * vendor-neutral agent knowledge (~/.symposium/repo), lets the user edit/test
 * backends (health + model + executable), and shows the sync/health of the
 * sufficit-ai memory hub. Replaces the static settings.json flow.
 *
 * All reads/writes go through the SymposiumApi facade, so the panel and the
 * remote bridge stay in lock-step.
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
            "Symposium · Configuration",
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = renderConfigHtml();
        this.panel.webview.onDidReceiveMessage(
            (m) => void this.onMessage(m), undefined, this.disposables);

        // Live refresh when repo files change on disk.
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(rootDir()), "repo/**"));
        watcher.onDidCreate(() => this.pushState(), undefined, this.disposables);
        watcher.onDidChange(() => this.pushState(), undefined, this.disposables);
        watcher.onDidDelete(() => this.pushState(), undefined, this.disposables);
        this.disposables.push(watcher);

        this.panel.onDidDispose(() => this.dispose(), undefined, context.subscriptions);
    }

    private async onMessage(message: {
        type: string; path?: string; kind?: ResourceKind; name?: string; backend?: string; value?: string; key?: string;
    }): Promise<void> {
        const api = this.deps.api;
        switch (message.type) {
            case "ready":
            case "refresh":
                await this.pushState();
                return;
            case "open-root":
                await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(rootDir()));
                return;
            case "open-file":
                if (message.path) {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                    await vscode.window.showTextDocument(doc, { preview: true });
                }
                return;
            case "seed": {
                const created = api.resources.seed();
                void vscode.window.showInformationMessage(
                    created > 0 ? `Created ${created} example(s).` : "Examples already existed.");
                await this.pushState();
                return;
            }
            case "new-resource": {
                if (!message.kind) {
                    return;
                }
                const name = await vscode.window.showInputBox({
                    prompt: `Name of the new ${message.kind}`,
                    validateInput: (v) => v.trim() ? undefined : "Enter a name.",
                });
                if (!name) {
                    return;
                }
                const description = await vscode.window.showInputBox({ prompt: "Description (optional)" }) ?? "";
                const file = api.resources.create(message.kind, name.trim(), description);
                await this.pushState();
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                await vscode.window.showTextDocument(doc);
                return;
            }
            case "delete-resource": {
                if (!message.kind || !message.name) {
                    return;
                }
                const ok = await vscode.window.showWarningMessage(
                    `Delete ${message.kind} "${message.name}"?`, { modal: true }, "Delete");
                if (ok === "Delete") {
                    api.resources.remove(message.kind, message.name);
                    await this.pushState();
                }
                return;
            }
            case "test-backend":
                if (message.backend) {
                    const s = await api.backends.test(message.backend);
                    void vscode.window.showInformationMessage(
                        s ? `${message.backend}: ${s.available ? "OK — " + s.detail : "unavailable — " + s.detail}`
                            : `${message.backend}: unknown`);
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
            case "add-endpoint": {
                const patch = await this.promptEndpoint();
                if (!patch) { return; }
                await api.backends.addAdapter(patch);
                await this.pushState();
                await this.offerReload(`Endpoint "${patch.name || patch.baseUrl}" added.`);
                return;
            }
            case "edit-endpoint": {
                const id = message.backend;
                if (!id) { return; }
                const current = this.readAdapterEntry(id);
                if (!current) { return; }
                const patch = await this.promptEndpoint(current);
                if (!patch) { return; }
                await api.backends.updateAdapter(id, patch);
                await this.pushState();
                await this.offerReload(`Endpoint updated. Reload to refresh its name in the pickers.`);
                return;
            }
            case "remove-endpoint": {
                const id = message.backend;
                if (!id) { return; }
                const current = this.readAdapterEntry(id);
                const label = current?.name || current?.baseUrl || id;
                const ok = await vscode.window.showWarningMessage(
                    `Remove endpoint "${label}"?`, { modal: true }, "Remove");
                if (ok !== "Remove") { return; }
                await api.backends.removeAdapter(id);
                await this.pushState();
                await this.offerReload(`Endpoint "${label}" removed.`);
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
                    // Coerce by key: numbers for hops, booleans for autoApprove.
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
                this.report("Pull", r);
                await this.pushState();
                return;
            }
            case "sync-push": {
                const r = await api.sync.push();
                this.report("Push", r);
                await this.pushState();
                return;
            }
            case "list-compression-presets": {
                const { CompressionManager } = await import("../compression");
                const presets = CompressionManager.getInstance().getPresets();
                this.panel.webview.postMessage({ type: "compression-presets", presets });
                return;
            }
            case "add-compression-preset": {
                const { CompressionManager } = await import("../compression");
                const name = await vscode.window.showInputBox({
                    prompt: "Nome do preset de compressão",
                    validateInput: (v) => v.trim() ? undefined : "Nome inválido",
                });
                if (!name) { return; }
                const presets = CompressionManager.getInstance().getPresets();
                const id = `custom-${Date.now()}`;
                const preset = presets[0]; // Clone first preset as template
                await CompressionManager.getInstance().savePreset({ ...preset, id, name: name.trim() });
                await this.pushState();
                return;
            }
            case "remove-compression-preset": {
                const { CompressionManager } = await import("../compression");
                if (!message.key) { return; }
                await CompressionManager.getInstance().deletePreset(message.key);
                await this.pushState();
                return;
            }
            case "edit-compression-preset": {
                const { CompressionManager } = await import("../compression");
                if (!message.key) { return; }
                const presets = CompressionManager.getInstance().getPresets();
                const preset = presets.find(p => p.id === message.key);
                if (!preset) { return; }
                const name = await vscode.window.showInputBox({
                    prompt: "Nome do preset",
                    value: preset.name,
                    validateInput: (v) => v.trim() ? undefined : "Nome inválido",
                });
                if (name === undefined) { return; }
                await CompressionManager.getInstance().savePreset({ ...preset, name: name.trim() });
                await this.pushState();
                return;
            }
            case "set-compression-preset-default": {
                const { CompressionManager } = await import("../compression");
                await CompressionManager.getInstance().setDefaultPreset(message.value ?? "");
                await this.pushState();
                return;
            }
        }
    }

    /** Reads one custom endpoint entry (by id) from symposium.adapters. */
    private readAdapterEntry(id: string): { id?: string; name?: string; baseUrl?: string; apiKey?: string; model?: string } | undefined {
        const arr = vscode.workspace.getConfiguration("symposium").get<Array<{ id?: string }>>("adapters", []) ?? [];
        return Array.isArray(arr) ? arr.find((a) => a && a.id === id) : undefined;
    }

    /**
     * Collects the editable endpoint fields through a sequence of input boxes
     * (base URL → name → API key → model). Returns the patch, or undefined if the
     * user cancels at any step (Esc). Prefilled from `current` when editing.
     */
    private async promptEndpoint(current?: { name?: string; baseUrl?: string; apiKey?: string; model?: string }): Promise<AdapterPatch | undefined> {
        const baseUrl = await vscode.window.showInputBox({
            title: current ? "Edit endpoint — Base URL" : "New endpoint — Base URL",
            prompt: "OpenAI-compatible base URL.",
            value: current?.baseUrl ?? "",
            placeHolder: "https://ai.sufficit.com.br/openai/v1",
            ignoreFocusOut: true,
            validateInput: (v) => {
                const s = v.trim();
                if (!s) { return "Base URL is required."; }
                try { new URL(s); return undefined; } catch { return "Enter a valid URL (https://…)."; }
            },
        });
        if (baseUrl === undefined) { return undefined; }
        const name = await vscode.window.showInputBox({
            title: "Endpoint — Display name (optional)",
            prompt: "Friendly name for the pickers. Empty derives a name from the URL.",
            value: current?.name ?? "",
            ignoreFocusOut: true,
        });
        if (name === undefined) { return undefined; }
        const apiKey = await vscode.window.showInputBox({
            title: "Endpoint — API key (optional)",
            prompt: "Sent as 'Authorization: Bearer <key>'. Empty = none.",
            value: current?.apiKey ?? "",
            password: true,
            ignoreFocusOut: true,
        });
        if (apiKey === undefined) { return undefined; }
        const model = await vscode.window.showInputBox({
            title: "Endpoint — Default model (optional)",
            prompt: "Default model id. Empty auto-discovers from <baseUrl>/models.",
            value: current?.model ?? "",
            ignoreFocusOut: true,
        });
        if (model === undefined) { return undefined; }
        return { baseUrl: baseUrl.trim(), name: name.trim(), apiKey: apiKey.trim(), model: model.trim() };
    }

    /** Confirms a CRUD change and offers a reload (added/removed endpoints register on reload). */
    private async offerReload(message: string): Promise<void> {
        const pick = await vscode.window.showInformationMessage(message, "Reload Window");
        if (pick === "Reload Window") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
    }

    private report(label: string, r: { pushed: number; pulled: number; skipped: number; errors: string[] }): void {
        if (r.errors.length) {
            void vscode.window.showWarningMessage(`${label}: ${r.errors.join(" · ")}`);
            return;
        }
        void vscode.window.showInformationMessage(
            `${label}: ${r.pulled} baixados, ${r.pushed} enviados, ${r.skipped} inalterados.`);
    }

    private async pushState(): Promise<void> {
        const api = this.deps.api;
        const profile = this.deps.auth ? await this.deps.auth.getProfile().catch(() => undefined) : undefined;
        const chat = vscode.workspace.getConfiguration("symposium.chat");
        const root = vscode.workspace.getConfiguration("symposium");
        const { CompressionManager } = await import("../compression");
        const compressionManager = CompressionManager.getInstance();
        const state = {
            root: api.resources.root(),
            resources: api.resources.scan(),
            backends: await api.backends.list(),
            sync: api.sync.status(),
            hubConfigured: api.sync.configured(),
            profile: profile ?? null,
            prefs: {
                sessionsSide: chat.get<string>("sessionsSide", "auto"),
                openIn: chat.get<string>("openIn", "editor"),
                preferredLanguage: chat.get<string>("preferredLanguage", ""),
                systemInstruction: chat.get<string>("systemInstruction", ""),
                lmTools: root.get<string>("lmTools", "terminal"),
                maxToolHops: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxToolHops", 50),
                noProgressStop: vscode.workspace.getConfiguration("symposium.openai").get<number>("noProgressStop", 0),
                autoCompactAt: vscode.workspace.getConfiguration("symposium.openai").get<number>("autoCompactAt", 0.8),
                maxHistoryMessages: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxHistoryMessages", 40),
                shellExecution: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
                autoApprove: vscode.workspace.getConfiguration().get<boolean>("chat.tools.global.autoApprove", false),
            },
            compression: {
                presets: compressionManager.getPresets(),
                defaultPresetId: compressionManager.getDefaultPresetId(),
                perSessionEnabled: compressionManager.isPerSessionEnabled(),
            },
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
