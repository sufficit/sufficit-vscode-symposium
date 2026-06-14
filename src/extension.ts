import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Working directory for a new session: the workspace folder, else the active
 * editor's folder, else the user's home. Never blocks on "open a folder".
 */
function defaultCwd(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        return ws;
    }
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && doc.uri.scheme === "file") {
        return path.dirname(doc.uri.fsPath);
    }
    return os.homedir();
}
import { ClaudeAdapter, ClaudeAdapterConfig } from "./adapters/claude";
import { CodexAdapter, CodexAdapterConfig } from "./adapters/codex";
import { CopilotAdapter, CopilotAdapterConfig } from "./adapters/copilot";
import { OpenAIAdapter, OpenAIAdapterConfig } from "./adapters/openai";
import { AgentAdapter, SessionInfo } from "./adapters/types";
import { SessionStore } from "./sessions/store";
import { LiveSessions } from "./sessions/runtime";
import { ChatPanel } from "./ui/chatPanel";
import { ChatSurfaceDeps } from "./ui/chatSurface";
import { ChatViewProvider } from "./ui/chatView";
import { snapshots } from "./snapshots";

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

function openaiConfig(): OpenAIAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.openai");
    return {
        baseUrl: config.get<string>("baseUrl", "https://api.openai.com/v1"),
        model: config.get<string>("model", ""),
        models: config.get<string[]>("models", []),
        headers: config.get<Record<string, string>>("headers", {}),
        apiKey: config.get<string>("apiKey", ""),
        log: symposiumLog,
    };
}

interface CustomAdapterDef {
    id: string;
    name?: string;
    baseUrl: string;
    model?: string;
    models?: string[];
    headers?: Record<string, string>;
    apiKey?: string;
}

/** Reads the user's extra OpenAI-compatible adapters (symposium.adapters). */
function customAdapterDefs(): CustomAdapterDef[] {
    const arr = vscode.workspace.getConfiguration("symposium").get<CustomAdapterDef[]>("adapters", []);
    return Array.isArray(arr) ? arr.filter((a) => a && a.id && a.baseUrl) : [];
}

/** One OpenAIAdapter per custom def, re-reading its entry live by id. */
function buildCustomAdapters(): OpenAIAdapter[] {
    return customAdapterDefs().map((def) =>
        new OpenAIAdapter(def.id, def.name || def.id, () => {
            const e = customAdapterDefs().find((x) => x.id === def.id) ?? def;
            return {
                baseUrl: e.baseUrl,
                model: e.model ?? "",
                models: e.models ?? [],
                headers: e.headers ?? {},
                apiKey: e.apiKey ?? "",
                log: symposiumLog,
            };
        }));
}

let output: vscode.OutputChannel | undefined;
export function symposiumLog(message: string): void {
    output?.appendLine(`${new Date().toISOString()} ${message}`);
}

// Backends that run as a CLI in a terminal (the rest are HTTP API adapters).
const CLI_BACKENDS = new Set(["claude", "codex", "copilot"]);

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel("Symposium");
    context.subscriptions.push(output);
    const adapters: AgentAdapter[] = [
        new ClaudeAdapter(claudeConfig),
        new CodexAdapter(codexConfig),
        new CopilotAdapter(copilotConfig),
        new OpenAIAdapter("openai", "Sufficit AI", openaiConfig),
        ...buildCustomAdapters(),
    ];
    const adapterByBackend = new Map<string, AgentAdapter>(
        adapters.map((adapter) => [adapter.backend, adapter]));

    const store = new SessionStore(context.globalState);
    // Forward-declared so the runtime can trigger a (debounced) sessions
    // refresh whenever an agent starts/stops working.
    let notifyStatus = () => { };
    const runtime = new LiveSessions(() => notifyStatus());
    context.subscriptions.push({ dispose: () => runtime.disposeAll() });

    const rawSessions = async (): Promise<SessionInfo[]> => {
        const all = await Promise.all(adapters.map((adapter) =>
            adapter.listSessions().catch(() => [] as SessionInfo[])));
        return all.flat()
            .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    };

    const deps: ChatSurfaceDeps = {
        adapterByBackend,
        // Return ALL sessions (archived flag + live runtime status); the webview
        // list shows/hides archived itself and renders the working indicator.
        // Live sessions not yet written to disk are merged in (top) so a brand-
        // new running session shows its working indicator immediately.
        listSessions: async () => {
            const disk = store.decorate(await rawSessions(), true)
                .map((s) => ({ ...s, status: runtime.statusFor(s.sessionId) }));
            const known = new Set(disk.map((s) => s.sessionId));
            const live = runtime.liveInfos()
                .filter((l) => !known.has(l.sessionId))
                .map((l) => ({ ...l, updatedAt: new Date() } as SessionInfo));
            return [...live, ...disk];
        },
        // Resume must run in the session's original cwd: the CLIs scope sessions per directory.
        cwdFor: (info) =>
            info.cwd && path.isAbsolute(info.cwd)
                ? info.cwd
                : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        runtime,
        lastActive: {
            // Per-workspace: reopening the window restores the session you were on.
            get: () => context.workspaceState.get("symposium.lastActive"),
            set: (value) => void context.workspaceState.update("symposium.lastActive", value),
        },
    };

    const chatView = new ChatViewProvider(deps);

    const refreshAll = () => {
        void chatView.refreshSessions();
        ChatPanel.refreshSessions();
    };
    // Debounce status-driven refreshes (turns flip busy frequently).
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    notifyStatus = () => {
        if (statusTimer) {
            clearTimeout(statusTimer);
        }
        statusTimer = setTimeout(refreshAll, 250);
    };
    const infoOf = (item: { info?: SessionInfo } | SessionInfo): SessionInfo =>
        "info" in item && item.info ? item.info : item as SessionInfo;

    // Open in the editor only when configured to AND the sidebar isn't the
    // surface in use: if the user acts from the visible sidebar view, the new
    // session stays there instead of jumping to a central editor panel.
    const inEditor = () =>
        vscode.workspace.getConfiguration("symposium.chat").get<string>("openIn", "editor") === "editor"
        && !chatView.visible;

    // Per-backend env for terminal-backed sessions (e.g. gateway routing).
    const envFor = (backend: string): Record<string, string> =>
        backend === "claude" ? claudeConfig().env : {};
    const modelFor = (backend: string): string =>
        backend === "claude" ? claudeConfig().model
            : backend === "codex" ? codexConfig().model
                : copilotConfig().model;
    const reasoningFor = (backend: string): string =>
        vscode.workspace.getConfiguration(`symposium.${backend}`).get<string>("reasoning", "default");

    const startTerminal = (backend: string, options: { cwd: string; resumeSessionId?: string; tmuxName?: string }, title: string) => {
        const opts = { ...options, env: envFor(backend), model: modelFor(backend) || undefined, reasoning: reasoningFor(backend) };
        if (inEditor()) {
            ChatPanel.show(context, deps).openTerminalDialogue(backend, opts, title);
        } else {
            void chatView.openTerminalDialogue(backend, opts, title);
        }
    };

    // Registry of tmux-backed persistent terminal sessions (survive VS Code quit).
    type PersistEntry = { tmuxName: string; backend: string; cwd: string; title: string };
    const persistKey = "symposium.persistentSessions";
    const persistGet = (): PersistEntry[] => context.workspaceState.get(persistKey, []);
    const persistAdd = (e: PersistEntry) => {
        const list = persistGet().filter((x) => x.tmuxName !== e.tmuxName);
        list.push(e);
        return context.workspaceState.update(persistKey, list);
    };
    const tmuxAlive = (name: string): Promise<boolean> =>
        new Promise((resolve) => {
            const child = cp.spawn("tmux", ["has-session", "-t", name], { stdio: "ignore" });
            child.on("error", () => resolve(false));
            child.on("exit", (code) => resolve(code === 0));
        });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView,
            { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand("symposium.refreshSessions", () => refreshAll()),

        // dev convenience: reload the window so a freshly installed vsix is
        // picked up. restartExtensionHost only reactivates the already-scanned
        // version and does NOT load a new build from disk; reloadWindow does.
        vscode.commands.registerCommand("symposium.reload", async () => {
            const pick = await vscode.window.showWarningMessage(
                "Reload the window to apply the latest installed Symposium build? Editors are restored after reload.",
                { modal: false },
                "Reload Window",
            );
            if (pick === "Reload Window") {
                await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
        }),

        // Opens VS Code's native Settings UI scoped to Symposium's chat config.
        vscode.commands.registerCommand("symposium.openSettings", () =>
            vscode.commands.executeCommand("workbench.action.openSettings", "@ext:sufficit.sufficit-vscode-symposium")),

        // Jump straight to the adapters array in settings.json for direct editing.
        vscode.commands.registerCommand("symposium.editAdapters", () =>
            vscode.commands.executeCommand("workbench.action.openSettingsJson", { revealSetting: { key: "symposium.adapters", edit: true } })),

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
            const cwd = defaultCwd();
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
            // Terminal sessions are CLI-only; the OpenAI adapter has no executable.
            const cliAdapters = adapters.filter((a) => CLI_BACKENDS.has(a.backend));
            const picks = await Promise.all(cliAdapters.map(async (adapter) => {
                const probe = await adapter.available();
                return { label: adapter.backend, description: probe.ok ? probe.version : `unavailable: ${probe.error}`, backend: adapter.backend, ok: probe.ok };
            }));
            const choice = await vscode.window.showQuickPick(picks.filter((p) => p.ok), {
                placeHolder: "Launch which agent in a terminal session?",
            });
            if (!choice) {
                return;
            }
            const cwd = defaultCwd();
            startTerminal(choice.backend, { cwd }, "Terminal session");
        }),

        vscode.commands.registerCommand("symposium.resumeInTerminal", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = infoOf(item);
            startTerminal(info.backend, { cwd: deps.cwdFor(info), resumeSessionId: info.sessionId }, info.title);
        }),

        vscode.commands.registerCommand("symposium.newPersistentSession", async () => {
            const hasTmux = await new Promise<boolean>((r) => {
                const c = cp.spawn("tmux", ["-V"], { stdio: "ignore" });
                c.on("error", () => r(false));
                c.on("exit", (code) => r(code === 0));
            });
            if (!hasTmux) {
                void vscode.window.showWarningMessage("tmux is not installed — persistent sessions need tmux (the agent runs inside a detached tmux session so it survives VS Code closing).");
                return;
            }
            const picks = await Promise.all(adapters.filter((a) => CLI_BACKENDS.has(a.backend)).map(async (a) => {
                const p = await a.available();
                return { label: a.backend, description: p.ok ? p.version : `unavailable: ${p.error}`, backend: a.backend, ok: p.ok };
            }));
            const choice = await vscode.window.showQuickPick(picks.filter((p) => p.ok), {
                placeHolder: "Launch which agent as a PERSISTENT (tmux) session?",
            });
            if (!choice) {
                return;
            }
            const cwd = defaultCwd();
            const tmuxName = `symposium-${choice.backend}-${Date.now().toString(36)}`;
            const title = `Persistent ${choice.backend}`;
            await persistAdd({ tmuxName, backend: choice.backend, cwd, title });
            startTerminal(choice.backend, { cwd, tmuxName }, title);
        }),

        vscode.commands.registerCommand("symposium.reattachPersistent", async () => {
            const entries = persistGet();
            const alive: PersistEntry[] = [];
            for (const e of entries) {
                if (await tmuxAlive(e.tmuxName)) {
                    alive.push(e);
                }
            }
            // Prune dead entries from the registry.
            if (alive.length !== entries.length) {
                await context.workspaceState.update(persistKey, alive);
            }
            if (!alive.length) {
                void vscode.window.showInformationMessage("No live persistent (tmux) sessions to reattach.");
                return;
            }
            const choice = await vscode.window.showQuickPick(
                alive.map((e) => ({ label: e.title, description: `${e.backend} · ${e.tmuxName}`, entry: e })),
                { placeHolder: "Reattach a live persistent session" },
            );
            if (!choice) {
                return;
            }
            // Re-running `tmux new-session -A -s <name>` attaches to the live process.
            startTerminal(choice.entry.backend, { cwd: choice.entry.cwd, tmuxName: choice.entry.tmuxName }, choice.entry.title);
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
                runtime.disposeBySessionId(info.sessionId); // stop it if running
                snapshots.clearSession(info.sessionId);      // drop in-memory baselines
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
    );
}

export function deactivate(): void { }
