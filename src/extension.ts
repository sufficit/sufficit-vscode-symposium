import * as cp from "child_process";
import { randomUUID } from "crypto";
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
import { AgentAdapter, SessionInfo, SessionStartOptions } from "./adapters/types";
import { SessionStore } from "./sessions/store";
import { LiveSessions } from "./sessions/runtime";
import { ChatPanel } from "./ui/chatPanel";
import { ChatSurfaceDeps } from "./ui/chatSurface";
import { ChatViewProvider } from "./ui/chatView";
import { ConfigPanel } from "./ui/configPanel";
import { createSymposiumApi, SymposiumApi } from "./api/symposiumApi";
import { RemoteBridge } from "./api/bridge";
import { seedExamples } from "./config/seed";
import { scanKind, readAgentBody, readAgentModel, readAgentTools } from "./config/root";
import { aiToolsForAgent } from "./adapters/aiTools";
import { SufficitAuth } from "./auth/identity";
import { SufficitAuthProvider } from "./auth/provider";
import { setHubTokenProvider } from "./sync/hubClient";

/** Normalizes a model label for pin matching: lowercase, drop "(...)", collapse spaces. */
function normModel(s: string): string {
    return s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Resolves an agent-def model pin (a label like "Sufficit AI - Development (ollama)")
 * to a real model id offered by the backend, via its discovered id→name labels.
 * Returns undefined when the backend isn't label-aware or no match is found
 * (caller then leaves the model unset → backend default).
 */
async function resolveModelPin(adapter: AgentAdapter, pin: string): Promise<string | undefined> {
    if (!pin) { return undefined; }
    const oa = adapter as unknown as {
        refreshModels?: () => Promise<{ models: string[]; labels?: Record<string, string> }>;
        modelLabels?: () => Record<string, string>;
        models?: () => string[];
    };
    if (!oa.modelLabels) { return undefined; }
    // If the pin is already a known model id, use it directly.
    if (oa.models && oa.models().includes(pin)) { return pin; }
    let labels = oa.modelLabels();
    if ((!labels || Object.keys(labels).length === 0) && oa.refreshModels) {
        labels = (await oa.refreshModels().catch(() => undefined))?.labels ?? labels;
    }
    const want = normModel(pin);
    for (const [id, name] of Object.entries(labels ?? {})) {
        if (normModel(name) === want) { return id; }
    }
    return undefined;
}
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
        api: config.get<"chat" | "responses">("api", "chat"),
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
    api?: "chat" | "responses";
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

/**
 * Ensures every adapter has a stable id (so renaming `name` never breaks its
 * sessions). Missing ids get an auto-generated GUID without hyphens; manual ids
 * in any format are kept. Persists generated ids back to settings.json.
 */
function normalizeAdapterDefs(): CustomAdapterDef[] {
    const cfg = vscode.workspace.getConfiguration("symposium");
    const arr = (cfg.get<CustomAdapterDef[]>("adapters", []) ?? []).filter((a) => a && a.baseUrl);
    let changed = false;
    for (const a of arr) {
        if (!a.id) { a.id = randomUUID().replace(/-/g, ""); changed = true; }
    }
    if (changed) { void cfg.update("adapters", arr, vscode.ConfigurationTarget.Global); }
    return arr;
}

/** One OpenAIAdapter per custom def, re-reading its entry live by id. */
function buildCustomAdapters(defs: CustomAdapterDef[]): OpenAIAdapter[] {
    return defs.map((def) =>
        new OpenAIAdapter(def.id, def.name || def.id, () => {
            const e = customAdapterDefs().find((x) => x.id === def.id) ?? def;
            return {
                api: e.api === "responses" ? "responses" : "chat",
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

export function activate(context: vscode.ExtensionContext): SymposiumApi {
    output = vscode.window.createOutputChannel("Symposium");
    context.subscriptions.push(output);
    const adapters: AgentAdapter[] = [
        new ClaudeAdapter(claudeConfig),
        new CodexAdapter(codexConfig),
        new CopilotAdapter(copilotConfig),
        new OpenAIAdapter("openai", "Sufficit AI", openaiConfig),
        ...buildCustomAdapters(normalizeAdapterDefs()),
    ];
    const adapterByBackend = new Map<string, AgentAdapter>(
        adapters.map((adapter) => [adapter.backend, adapter]));

    const store = new SessionStore(context.globalState);
    // Forward-declared so the runtime can trigger a (debounced) sessions
    // refresh whenever an agent starts/stops working.
    let notifyStatus = () => { };
    const runtime = new LiveSessions(() => notifyStatus());
    context.subscriptions.push({ dispose: () => runtime.disposeAll() });
    // Public API consumers (in-process exports + remote bridge) subscribe here.
    const sessionsChanged = new vscode.EventEmitter<void>();
    context.subscriptions.push(sessionsChanged);
    // Public API facade (in-process exports, config UI and remote bridge all
    // share this object so every surface stays in lock-step).
    const api = createSymposiumApi({ live: runtime, adapters, onSessionsChanged: sessionsChanged.event });

    // Sufficit Identity login (tokens in SecretStorage; basis for memory/MCP).
    const auth = new SufficitAuth(context, symposiumLog);
    context.subscriptions.push(auth.onDidChange(() => ConfigPanel.refresh()));
    // Native Accounts-menu integration (avatar/login at the bottom of the activity bar).
    SufficitAuthProvider.register(context, auth);
    // Hub/MCP requests use the logged-in identity token when available.
    setHubTokenProvider(() => auth.getAccessToken());

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
        account: {
            get: () => auth.getProfile(),
            onDidChange: auth.onDidChange,
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
        sessionsChanged.fire();
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

        // Dynamic configuration surface: agents/skills/tools/backends/sync.
        vscode.commands.registerCommand("symposium.openConfig", () =>
            ConfigPanel.show(context, { api, auth })),

        // Sufficit Identity login / logout via the native auth provider (also
        // shows in the VS Code Accounts menu).
        vscode.commands.registerCommand("symposium.login", async () => {
            try {
                const session = await vscode.authentication.getSession(
                    SufficitAuthProvider.id, ["openid", "profile", "email", "offline_access"], { createIfNone: true });
                if (session) { void vscode.window.showInformationMessage(`Sufficit: logado como ${session.account.label}.`); }
            } catch (err) {
                void vscode.window.showErrorMessage(`Login Sufficit falhou: ${err instanceof Error ? err.message : err}`);
            }
        }),
        vscode.commands.registerCommand("symposium.logout", async () => {
            await auth.logout();
            void vscode.window.showInformationMessage("Sufficit: sessão encerrada.");
        }),

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

        // New session bound to a local agent-def: seeds the system prompt from the
        // agent's instructions and gates AI tools (memory/web) by its declared tools.
        vscode.commands.registerCommand("symposium.newAgentSession", async () => {
            const agents = scanKind("agent");
            if (agents.length === 0) {
                void vscode.window.showWarningMessage("Nenhum agente em ~/.symposium/repo/agents. Use Seed/Import ou crie um na Configuração.");
                return;
            }
            const agent = await vscode.window.showQuickPick(
                agents.map((a) => ({ label: a.name, description: a.description, name: a.name })),
                { placeHolder: "Qual agente?" });
            if (!agent) {
                return;
            }
            const picks = await Promise.all(adapters.map(async (adapter) => {
                const probe = await adapter.available();
                return { label: adapter.backend, description: probe.ok ? probe.version : `unavailable: ${probe.error}`, adapter, ok: probe.ok };
            }));
            const choice = await vscode.window.showQuickPick(picks, { placeHolder: `Backend para "${agent.name}"` });
            if (!choice) {
                return;
            }
            if (!choice.ok) {
                void vscode.window.showWarningMessage(`${choice.label} indisponível: ${choice.description}`);
                return;
            }
            const model = await resolveModelPin(choice.adapter, readAgentModel(agent.name));
            const options: SessionStartOptions = {
                cwd: defaultCwd(),
                systemPrompt: readAgentBody(agent.name),
                aiTools: aiToolsForAgent(readAgentTools(agent.name)),
                ...(model ? { model } : {}),
            };
            const title = `Agente: ${agent.name}`;
            if (inEditor()) {
                ChatPanel.show(context, deps).openDialogue(choice.adapter.backend, options, title);
            } else {
                void chatView.openDialogue(choice.adapter.backend, options, title);
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

        vscode.commands.registerCommand("symposium.pinSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.setPinned(infoOf(item), true);
            refreshAll();
        }),
        vscode.commands.registerCommand("symposium.unpinSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.setPinned(infoOf(item), false);
            refreshAll();
        }),
        vscode.commands.registerCommand("symposium.pinUp", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.movePinned(infoOf(item), -1);
            refreshAll();
        }),
        vscode.commands.registerCommand("symposium.pinDown", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.movePinned(infoOf(item), 1);
            refreshAll();
        }),
        vscode.commands.registerCommand("symposium.reorderPinned", async (ids: string[]) => {
            await store.setPinnedOrder(Array.isArray(ids) ? ids : []);
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
                // Close the conversation pane if it's showing the deleted session.
                chatView.sessionDeleted(info.sessionId);
                ChatPanel.sessionDeleted(info.sessionId);
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

    // Opt-in remote control bridge (off unless symposium.bridge.enabled).
    const bridge = new RemoteBridge(api, (msg) => output?.appendLine(msg));
    bridge.start();
    context.subscriptions.push({ dispose: () => bridge.stop() });

    context.subscriptions.push(
        // Writes example resources into ~/.symposium so the config UI and API
        // can be validated fully offline.
        vscode.commands.registerCommand("symposium.seedExamples", async () => {
            const created = seedExamples();
            void vscode.window.showInformationMessage(
                created > 0
                    ? `Symposium: ${created} exemplo(s) criado(s) em ~/.symposium/repo.`
                    : "Symposium: exemplos já existiam (nada criado).");
            ConfigPanel.show(context, { api, auth });
        }),

        // Restart the bridge to apply changed bridge settings.
        vscode.commands.registerCommand("symposium.restartBridge", () => {
            bridge.stop();
            const url = bridge.start();
            void vscode.window.showInformationMessage(
                url ? `Symposium bridge: ${url}` : "Symposium bridge desativado (symposium.bridge.enabled=false).");
        }),
    );

    return api;
}

export function deactivate(): void { }
