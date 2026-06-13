import * as path from "path";
import * as vscode from "vscode";
import { ClaudeAdapter, ClaudeAdapterConfig } from "./adapters/claude";
import { CodexAdapter, CodexAdapterConfig } from "./adapters/codex";
import { CopilotAdapter, CopilotAdapterConfig } from "./adapters/copilot";
import { AgentAdapter, SessionInfo } from "./adapters/types";
import { SessionsTreeProvider } from "./sessions/tree";
import { SessionStore } from "./sessions/store";
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

function codexConfig(): CodexAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.codex");
    return {
        executable: config.get<string>("executable", "codex"),
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
        new CodexAdapter(codexConfig),
        new CopilotAdapter(copilotConfig),
    ];
    const adapterByBackend = new Map<string, AgentAdapter>(
        adapters.map((adapter) => [adapter.backend, adapter]));

    const store = new SessionStore(context.globalState);
    let showArchived = false;

    const rawSessions = async (): Promise<SessionInfo[]> => {
        const all = await Promise.all(adapters.map((adapter) =>
            adapter.listSessions().catch(() => [] as SessionInfo[])));
        return all.flat()
            .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    };

    const deps: ChatSurfaceDeps = {
        adapterByBackend,
        // Chat surfaces never show archived sessions in their list.
        listSessions: async () => store.decorate(await rawSessions(), false),
        // Resume must run in the session's original cwd: the CLIs scope sessions per directory.
        cwdFor: (info) =>
            info.cwd && path.isAbsolute(info.cwd)
                ? info.cwd
                : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    };

    // The tree can also show archived sessions when toggled on.
    const tree = new SessionsTreeProvider(async () => store.decorate(await rawSessions(), showArchived));
    const chatView = new ChatViewProvider(deps);

    const refreshAll = () => {
        tree.refresh();
        void chatView.refreshSessions();
        ChatPanel.refreshSessions();
    };
    const infoOf = (item: { info?: SessionInfo } | SessionInfo): SessionInfo =>
        "info" in item && item.info ? item.info : item as SessionInfo;

    const inEditor = () =>
        vscode.workspace.getConfiguration("symposium.chat").get<string>("openIn", "editor") === "editor";

    // Per-backend env for terminal-backed sessions (e.g. gateway routing).
    const envFor = (backend: string): Record<string, string> =>
        backend === "claude" ? claudeConfig().env : {};
    const modelFor = (backend: string): string =>
        backend === "claude" ? claudeConfig().model
            : backend === "codex" ? codexConfig().model
                : copilotConfig().model;

    const startTerminal = (backend: string, options: { cwd: string; resumeSessionId?: string }, title: string) => {
        const opts = { ...options, env: envFor(backend), model: modelFor(backend) || undefined };
        if (inEditor()) {
            ChatPanel.show(context, deps).openTerminalDialogue(backend, opts, title);
        } else {
            void chatView.openTerminalDialogue(backend, opts, title);
        }
    };

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

        vscode.commands.registerCommand("symposium.followSession", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = "info" in item && item.info ? item.info : item as SessionInfo;
            if (inEditor()) {
                void ChatPanel.show(context, deps).followSession(info);
            } else {
                void chatView.followSession(info);
            }
        }),

        vscode.commands.registerCommand("symposium.newTerminalSession", async () => {
            const picks = await Promise.all(adapters.map(async (adapter) => {
                const probe = await adapter.available();
                return { label: adapter.backend, description: probe.ok ? probe.version : `unavailable: ${probe.error}`, backend: adapter.backend, ok: probe.ok };
            }));
            const choice = await vscode.window.showQuickPick(picks.filter((p) => p.ok), {
                placeHolder: "Launch which agent in a terminal session?",
            });
            if (!choice) {
                return;
            }
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!cwd) {
                void vscode.window.showWarningMessage("Open a folder first; sessions are bound to a working directory.");
                return;
            }
            startTerminal(choice.backend, { cwd }, "Terminal session");
        }),

        vscode.commands.registerCommand("symposium.resumeInTerminal", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = infoOf(item);
            startTerminal(info.backend, { cwd: deps.cwdFor(info), resumeSessionId: info.sessionId }, info.title);
        }),

        vscode.commands.registerCommand("symposium.renameSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            const info = infoOf(item);
            const value = await vscode.window.showInputBox({
                prompt: "Rename session",
                value: info.title,
                valueSelection: [0, info.title.length],
            });
            if (value === undefined) {
                return; // cancelled
            }
            await store.setTitle(info, value);
            refreshAll();
        }),

        vscode.commands.registerCommand("symposium.archiveSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.setArchived(infoOf(item), true);
            refreshAll();
        }),

        vscode.commands.registerCommand("symposium.unarchiveSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.setArchived(infoOf(item), false);
            refreshAll();
        }),

        vscode.commands.registerCommand("symposium.deleteSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            const info = infoOf(item);
            const adapter = adapterByBackend.get(info.backend);
            if (!adapter?.deleteSession) {
                void vscode.window.showWarningMessage(`Deleting ${info.backend} sessions is not supported.`);
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete "${info.title}"?\n\nThis scrubs the transcript and all history/index entries for this session (${info.sessionId}) from the ${info.backend} CLI on disk. It cannot be undone.`,
                { modal: true },
                "Delete permanently",
            );
            if (confirm !== "Delete permanently") {
                return;
            }
            try {
                const residual = await adapter.deleteSession(info);
                await store.forget(info);
                refreshAll();
                if (Array.isArray(residual) && residual.length) {
                    void vscode.window.showWarningMessage(
                        `Session deleted. Residual data may remain in: ${residual.join(", ")} — clear it manually if required.`);
                } else {
                    void vscode.window.showInformationMessage(`Session "${info.title}" permanently deleted.`);
                }
            } catch (error) {
                void vscode.window.showErrorMessage(`Delete failed: ${error instanceof Error ? error.message : error}`);
            }
        }),

        vscode.commands.registerCommand("symposium.toggleArchived", () => {
            showArchived = !showArchived;
            void vscode.window.showInformationMessage(`Symposium: archived sessions ${showArchived ? "shown" : "hidden"}.`);
            tree.refresh();
        }),
    );
}

export function deactivate(): void { }
