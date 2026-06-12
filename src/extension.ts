import * as path from "path";
import * as vscode from "vscode";
import { ClaudeAdapter, ClaudeAdapterConfig } from "./adapters/claude";
import { CopilotAdapter, CopilotAdapterConfig } from "./adapters/copilot";
import { StubAdapter } from "./adapters/stubs";
import { AgentAdapter, SessionInfo } from "./adapters/types";
import { SessionsTreeProvider } from "./sessions/tree";
import { ChatPanel } from "./ui/chatPanel";
import { ChatSurfaceDeps } from "./ui/chatSurface";
import { ChatViewProvider } from "./ui/chatView";

function claudeConfig(): ClaudeAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.claude");
    return {
        executable: config.get<string>("executable", "claude"),
        model: config.get<string>("model", ""),
        permissionMode: config.get<string>("permissionMode", "default"),
        env: config.get<Record<string, string>>("env", {}),
        log: symposiumLog,
    };
}

function copilotConfig(): CopilotAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.copilot");
    return {
        executable: config.get<string>("executable", "copilot"),
        model: config.get<string>("model", ""),
    };
}

let output: vscode.OutputChannel | undefined;
export function symposiumLog(message: string): void {
    output?.appendLine(`${new Date().toISOString()} ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel("Symposium");
    context.subscriptions.push(output);
    const adapters: AgentAdapter[] = [
        new ClaudeAdapter(claudeConfig),
        new CopilotAdapter(copilotConfig),
        new StubAdapter("codex"),
    ];
    const adapterByBackend = new Map<string, AgentAdapter>(
        adapters.map((adapter) => [adapter.backend, adapter]));

    const deps: ChatSurfaceDeps = {
        adapterByBackend,
        listSessions: async () => {
            const all = await Promise.all(adapters.map((adapter) =>
                adapter.listSessions().catch(() => [] as SessionInfo[])));
            return all.flat()
                .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
        },
        // Resume must run in the session's original cwd: the CLIs scope sessions per directory.
        cwdFor: (info) =>
            info.cwd && path.isAbsolute(info.cwd)
                ? info.cwd
                : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    };

    const tree = new SessionsTreeProvider(adapters);
    const chatView = new ChatViewProvider(deps);

    const inEditor = () =>
        vscode.workspace.getConfiguration("symposium.chat").get<string>("openIn", "editor") === "editor";

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("symposium.sessions", tree),
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView,
            { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand("symposium.refreshSessions", () => tree.refresh()),

        // dev convenience: reload the freshly installed vsix without reloading the window
        vscode.commands.registerCommand("symposium.restartExtensionHost", () =>
            vscode.commands.executeCommand("workbench.action.restartExtensionHost")),

        vscode.commands.registerCommand("symposium.newSession", async () => {
            const picks = await Promise.all(adapters.map(async (adapter) => {
                const probe = await adapter.available();
                return {
                    label: adapter.backend,
                    description: probe.ok ? probe.version : `unavailable: ${probe.error}`,
                    adapter,
                    ok: probe.ok,
                };
            }));
            const choice = await vscode.window.showQuickPick(picks, {
                placeHolder: "Which agent joins the symposium?",
            });
            if (!choice) {
                return;
            }
            if (!choice.ok) {
                void vscode.window.showWarningMessage(
                    `${choice.label} CLI is not available: ${choice.description}`);
                return;
            }
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!cwd) {
                void vscode.window.showWarningMessage("Open a folder first; sessions are bound to a working directory.");
                return;
            }
            if (inEditor()) {
                ChatPanel.show(context, deps).openDialogue(choice.adapter.backend, { cwd }, "New dialogue");
            } else {
                void chatView.openDialogue(choice.adapter.backend, { cwd }, "New dialogue");
            }
        }),

        vscode.commands.registerCommand("symposium.openSession", (info: SessionInfo) => {
            if (inEditor()) {
                ChatPanel.show(context, deps).openSession(info);
            } else {
                void chatView.openSession(info);
            }
        }),

        vscode.commands.registerCommand("symposium.openSessionInEditor", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = "info" in item && item.info ? item.info : item as SessionInfo;
            ChatPanel.show(context, deps).openSession(info);
        }),
    );
}

export function deactivate(): void { }
