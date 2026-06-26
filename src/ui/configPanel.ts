import * as vscode from "vscode";
import { ensureScaffold, ResourceKind, rootDir } from "../config/root";
import { AdapterPatch, SymposiumApi } from "../api/symposiumApi";
import { SufficitAuth } from "../auth/identity";
import { renderConfigHtml } from "./configHtml";
import { tr } from "./configI18n";

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

    private async onMessage(message: {
        type: string; path?: string; kind?: ResourceKind; name?: string; backend?: string; value?: string; key?: string;
    }): Promise<void> {
        const api = this.deps.api;
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
                    created > 0 ? this.tr("msg.seed.created", { n: created }) : this.tr("msg.seed.existed"));
                await this.pushState();
                return;
            }
            case "import-agents": {
                const r = api.resources.importAgents();
                void vscode.window.showInformationMessage(
                    r.created > 0
                        ? this.tr("msg.import.agents.done", { n: r.created }) + (r.skipped ? this.tr("msg.import.agents.skippedSuffix", { n: r.skipped }) : "")
                        : (r.skipped > 0
                            ? this.tr("msg.import.agents.allExisted", { n: r.skipped })
                            : this.tr("msg.import.agents.none")));
                await this.pushState();
                return;
            }
            case "import-tools": {
                const r = api.resources.importTools();
                void vscode.window.showInformationMessage(
                    r.created > 0
                        ? this.tr("msg.import.tools.done", { n: r.created }) + (r.skipped ? this.tr("msg.import.tools.skippedSuffix", { n: r.skipped }) : "")
                        : (r.skipped > 0
                            ? this.tr("msg.import.tools.allExisted", { n: r.skipped })
                            : this.tr("msg.import.tools.none")));
                await this.pushState();
                return;
            }
            case "import-instructions": {
                const r = api.resources.importInstructions();
                void vscode.window.showInformationMessage(
                    r.created > 0
                        ? this.tr("msg.import.instructions.done", { n: r.created }) + (r.skipped ? this.tr("msg.import.instructions.skippedSuffix", { n: r.skipped }) : "")
                        : (r.skipped > 0
                            ? this.tr("msg.import.instructions.allExisted", { n: r.skipped })
                            : this.tr("msg.import.instructions.none")));
                await this.pushState();
                return;
            }
            case "import-skills": {
                const found = api.resources.scanForeignSkills();
                if (!found.length) {
                    void vscode.window.showInformationMessage(
                        this.tr("msg.import.skills.none"));
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    found.map((s) => ({ label: s.name, description: s.source, detail: s.description, srcPath: s.path })),
                    { canPickMany: true, placeHolder: this.tr("msg.import.skills.pickPlaceholder") });
                if (!picked || !picked.length) {
                    return;
                }
                const r = api.resources.importSkills(picked.map((p) => p.srcPath));
                void vscode.window.showInformationMessage(
                    this.tr("msg.import.skills.done", { n: r.imported }) +
                    (r.skipped ? this.tr("msg.import.skills.skippedSuffix", { n: r.skipped }) : "") +
                    (r.errors.length ? this.tr("msg.import.skills.failedSuffix", { n: r.errors.length, errors: r.errors.join(", ") }) : "") + ".");
                await this.pushState();
                return;
            }
            case "install-skill-sh": {
                const pkg = await vscode.window.showInputBox({
                    prompt: this.tr("msg.installSkillSh.prompt"),
                    placeHolder: "vercel-labs/agent-skills",
                    validateInput: (v) => /^[\w.-]+\/[\w.-]+$/.test(v.trim()) ? undefined : this.tr("msg.installSkillSh.invalid"),
                });
                if (!pkg) {
                    return;
                }
                const term = vscode.window.createTerminal({ name: "skills.sh", env: { DISABLE_TELEMETRY: "1" } });
                term.show();
                term.sendText(`npx --yes skills add ${pkg.trim()}`);
                void vscode.window.showInformationMessage(
                    this.tr("msg.installSkillSh.started", { pkg: pkg.trim() }));
                return;
            }
            case "new-resource": {
                if (!message.kind) {
                    return;
                }
                const name = await vscode.window.showInputBox({
                    prompt: this.tr("msg.newResource.namePrompt", { kind: this.tr("config.kind." + message.kind) }),
                    validateInput: (v) => v.trim() ? undefined : this.tr("msg.newResource.nameRequired"),
                });
                if (!name) {
                    return;
                }
                const description = await vscode.window.showInputBox({ prompt: this.tr("msg.newResource.descPrompt") }) ?? "";
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
                const del = this.tr("msg.deleteResource.confirmAction");
                const ok = await vscode.window.showWarningMessage(
                    this.tr("msg.deleteResource.confirm", { kind: this.tr("config.kind." + message.kind), name: message.name }), { modal: true }, del);
                if (ok === del) {
                    api.resources.remove(message.kind, message.name);
                    await this.pushState();
                }
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
            case "add-endpoint": {
                const patch = await this.promptEndpoint();
                if (!patch) { return; }
                await api.backends.addAdapter(patch);
                await this.pushState();
                await this.offerReload(this.tr("msg.endpoint.added", { name: patch.name || patch.baseUrl || "" }));
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
                await this.offerReload(this.tr("msg.endpoint.updated"));
                return;
            }
            case "remove-endpoint": {
                const id = message.backend;
                if (!id) { return; }
                const current = this.readAdapterEntry(id);
                const label = current?.name || current?.baseUrl || id;
                const rm = this.tr("msg.endpoint.removeAction");
                const ok = await vscode.window.showWarningMessage(
                    this.tr("msg.endpoint.removeConfirm", { label }), { modal: true }, rm);
                if (ok !== rm) { return; }
                await api.backends.removeAdapter(id);
                await this.pushState();
                await this.offerReload(this.tr("msg.endpoint.removed", { label }));
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
            title: current ? this.tr("msg.promptEndpoint.baseUrlTitleEdit") : this.tr("msg.promptEndpoint.baseUrlTitleNew"),
            prompt: this.tr("msg.promptEndpoint.baseUrlPrompt"),
            value: current?.baseUrl ?? "",
            placeHolder: "https://ai.sufficit.com.br/openai/v1",
            ignoreFocusOut: true,
            validateInput: (v) => {
                const s = v.trim();
                if (!s) { return this.tr("msg.promptEndpoint.baseUrlRequired"); }
                try { new URL(s); return undefined; } catch { return this.tr("msg.promptEndpoint.baseUrlInvalid"); }
            },
        });
        if (baseUrl === undefined) { return undefined; }
        const name = await vscode.window.showInputBox({
            title: this.tr("msg.promptEndpoint.nameTitle"),
            prompt: this.tr("msg.promptEndpoint.namePrompt"),
            value: current?.name ?? "",
            ignoreFocusOut: true,
        });
        if (name === undefined) { return undefined; }
        const apiKey = await vscode.window.showInputBox({
            title: this.tr("msg.promptEndpoint.apiKeyTitle"),
            prompt: this.tr("msg.promptEndpoint.apiKeyPrompt"),
            value: current?.apiKey ?? "",
            password: true,
            ignoreFocusOut: true,
        });
        if (apiKey === undefined) { return undefined; }
        const model = await vscode.window.showInputBox({
            title: this.tr("msg.promptEndpoint.modelTitle"),
            prompt: this.tr("msg.promptEndpoint.modelPrompt"),
            value: current?.model ?? "",
            ignoreFocusOut: true,
        });
        if (model === undefined) { return undefined; }
        return { baseUrl: baseUrl.trim(), name: name.trim(), apiKey: apiKey.trim(), model: model.trim() };
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
        const chat = vscode.workspace.getConfiguration("symposium.chat");
        const root = vscode.workspace.getConfiguration("symposium");
        const state = {
            root: api.resources.root(),
            resources: api.resources.scan(),
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
                lmTools: root.get<string>("lmTools", "terminal"),
                maxToolHops: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxToolHops", 50),
                noProgressStop: vscode.workspace.getConfiguration("symposium.openai").get<number>("noProgressStop", 0),
                autoCompactAt: vscode.workspace.getConfiguration("symposium.openai").get<number>("autoCompactAt", 0.8),
                maxHistoryMessages: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxHistoryMessages", 40),
                shellExecution: vscode.workspace.getConfiguration("symposium.openai").get<string>("shellExecution", "silent"),
                autoApprove: vscode.workspace.getConfiguration().get<boolean>("chat.tools.global.autoApprove", false),
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
