import * as vscode from "vscode";
import { ensureScaffold, ResourceKind, rootDir } from "../config/root";
import { SymposiumApi } from "../api/symposiumApi";
import { renderConfigHtml } from "./configHtml";

export interface ConfigPanelDeps {
    api: SymposiumApi;
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

    private constructor(context: vscode.ExtensionContext, private readonly deps: ConfigPanelDeps) {
        ensureScaffold();
        this.panel = vscode.window.createWebviewPanel(
            "symposium.config",
            "Symposium · Configuração",
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
        type: string; path?: string; kind?: ResourceKind; name?: string; backend?: string; value?: string;
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
                    created > 0 ? `${created} exemplo(s) criado(s).` : "Exemplos já existiam.");
                await this.pushState();
                return;
            }
            case "new-resource": {
                if (!message.kind) {
                    return;
                }
                const name = await vscode.window.showInputBox({
                    prompt: `Nome do novo ${message.kind}`,
                    validateInput: (v) => v.trim() ? undefined : "Informe um nome.",
                });
                if (!name) {
                    return;
                }
                const description = await vscode.window.showInputBox({ prompt: "Descrição (opcional)" }) ?? "";
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
                    `Excluir ${message.kind} "${message.name}"?`, { modal: true }, "Excluir");
                if (ok === "Excluir") {
                    api.resources.remove(message.kind, message.name);
                    await this.pushState();
                }
                return;
            }
            case "test-backend":
                if (message.backend) {
                    const s = await api.backends.test(message.backend);
                    void vscode.window.showInformationMessage(
                        s ? `${message.backend}: ${s.available ? "OK — " + s.detail : "indisponível — " + s.detail}`
                            : `${message.backend}: desconhecido`);
                    await this.pushState();
                }
                return;
            case "edit-backend": {
                const b = message.backend ?? "";
                const cli = b === "claude" || b === "codex" || b === "copilot";
                if (cli) {
                    // CLI backend: its executable/model/etc live in settings.
                    await vscode.commands.executeCommand("workbench.action.openSettings", "symposium." + b);
                } else {
                    // API/custom backend (openai, sufficit-ai, …): edit the adapters JSON.
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
        }
    }

    private async pushState(): Promise<void> {
        const api = this.deps.api;
        const state = {
            root: api.resources.root(),
            resources: api.resources.scan(),
            backends: await api.backends.list(),
            sync: api.sync.status(),
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
