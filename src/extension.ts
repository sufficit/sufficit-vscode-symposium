import * as vscode from "vscode";
import { ClaudeAdapter, ClaudeAdapterConfig } from "./adapters/claude";
import { StubAdapter } from "./adapters/stubs";
import { AgentAdapter, SessionInfo } from "./adapters/types";
import { SessionsTreeProvider } from "./sessions/tree";
import { ChatPanel } from "./ui/chatPanel";

function claudeConfig(): ClaudeAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.claude");
    return {
        executable: config.get<string>("executable", "claude"),
        model: config.get<string>("model", ""),
        permissionMode: config.get<string>("permissionMode", "default"),
        env: config.get<Record<string, string>>("env", {}),
    };
}

export function activate(context: vscode.ExtensionContext): void {
    const adapters: AgentAdapter[] = [
        new ClaudeAdapter(claudeConfig),
        new StubAdapter("codex"),
        new StubAdapter("copilot"),
    ];
    const adapterByBackend = new Map(adapters.map((adapter) => [adapter.backend, adapter]));

    const tree = new SessionsTreeProvider(adapters);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("symposium.sessions", tree),
        vscode.commands.registerCommand("symposium.refreshSessions", () => tree.refresh()),

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
            ChatPanel.open(context, choice.adapter, { cwd }, "New dialogue");
        }),

        vscode.commands.registerCommand("symposium.openSession", (info: SessionInfo) => {
            const adapter = adapterByBackend.get(info.backend);
            if (!adapter) {
                return;
            }
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
            ChatPanel.open(context, adapter, { cwd, resumeSessionId: info.sessionId }, info.title);
        }),
    );
}

export function deactivate(): void { }
