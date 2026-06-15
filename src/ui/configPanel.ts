import * as vscode from "vscode";
import { AgentAdapter } from "../adapters/types";
import {
    createResource, deleteResource, ensureScaffold, readState, ResourceKind,
    rootDir, scanAll,
} from "../config/root";
import { seedExamples } from "../config/seed";
import { renderConfigHtml } from "./configHtml";

export interface ConfigPanelDeps {
    adapters: AgentAdapter[];
}

interface BackendStatus {
    backend: string;
    available: boolean;
    detail: string;
}

/**
 * Dynamic configuration surface: a reusable webview panel that lists the local
 * vendor-neutral agent knowledge (~/.symposium/repo), the configured backends
 * and the sync/health of the sufficit-ai memory hub. Replaces the static
 * settings.json flow for managing agents/skills/tools.
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

    private async onMessage(message: { type: string; path?: string; kind?: ResourceKind; name?: string; backend?: string; value?: string }): Promise<void> {
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
                const created = seedExamples();
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
                const file = createResource(message.kind, name.trim(), description);
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
                    deleteResource(message.kind, message.name);
                    await this.pushState();
                }
                return;
            }
        }
    }

    private async probeBackends(): Promise<BackendStatus[]> {
        return Promise.all(this.deps.adapters.map(async (a) => {
            try {
                const probe = await a.available();
                return {
                    backend: a.backend,
                    available: probe.ok,
                    detail: probe.ok ? (probe.version ?? "") : (probe.error ?? "indisponível"),
                };
            } catch (err) {
                return { backend: a.backend, available: false, detail: String(err) };
            }
        }));
    }

    private async pushState(): Promise<void> {
        const state = {
            root: rootDir(),
            resources: scanAll(),
            backends: await this.probeBackends(),
            sync: readState(),
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
