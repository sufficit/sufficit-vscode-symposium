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
import { OpenAIAdapter, OpenAIAdapterConfig, setOpenAITokenProvider } from "./adapters/openai";
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
import { scanKind, readAgentBody, readAgentBootstrap, readAgentModel, readAgentTools } from "./config/root";
import { aiToolsForAgent } from "./adapters/aiTools";
import { SufficitAuth } from "./auth/identity";
import { SufficitAuthProvider } from "./auth/provider";
import { setHubTokenProvider, HubClient } from "./sync/hubClient";
import { expireSessionTasks } from "./sync/tasks";

/** Normalizes a model label for pin matching: lowercase, drop "(...)", collapse spaces. */

function errorDetails(error: unknown): string {
    if (error instanceof Error) { return error.stack || error.message; }
    try { return JSON.stringify(error, null, 2); } catch { return String(error); }
}

async function showErrorWithCopy(message: string, details: string): Promise<void> {
    const action = await vscode.window.showErrorMessage(message, "Copy details");
    if (action === "Copy details") {
        await vscode.env.clipboard.writeText(details);
        void vscode.window.showInformationMessage("Details copied to clipboard.");
    }
}

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
    if (!adapter.modelLabels) { return undefined; }
    // If the pin is already a known model id, use it directly.
    if (adapter.models && adapter.models().includes(pin)) { return pin; }
    let labels = adapter.modelLabels();
    if ((!labels || Object.keys(labels).length === 0) && adapter.refreshModels) {
        labels = (await adapter.refreshModels().catch(() => undefined))?.labels ?? labels;
    }
    const want = normModel(pin);
    for (const [id, name] of Object.entries(labels ?? {})) {
        if (normModel(name) === want) { return id; }
    }
    return undefined;
}
import { snapshots } from "./snapshots";

/** Install commands for known CLI backends (shown when the CLI is missing). */
const CLI_INSTALL: Record<string, { cmd: string; label: string }> = {
    codex: { cmd: "npm install -g @openai/codex", label: "Install Codex CLI" },
    claude: { cmd: "npm install -g @anthropic-ai/claude-code", label: "Install Claude Code" },
    copilot: { cmd: "npm install -g @github/copilot-cli", label: "Install Copilot CLI" },
};

/**
 * Show a warning for an unavailable backend with an optional install shortcut.
 * Opens a new terminal and runs the install command when the user accepts.
 */
async function promptInstallCli(backend: string, label: string, errorDesc: string): Promise<void> {
    const install = CLI_INSTALL[backend];
    const isEnoent = /ENOENT|not found|command not found/i.test(errorDesc);
    if (install && isEnoent) {
        const choice = await vscode.window.showWarningMessage(
            `${label} CLI not found.`,
            { modal: false },
            install.label,
        );
        if (choice === install.label) {
            const term = vscode.window.createTerminal({ name: `Install ${label}` });
            term.show();
            term.sendText(install.cmd);
        }
    } else {
        void vscode.window.showWarningMessage(`${label} CLI unavailable: ${errorDesc}`);
    }
}

function claudeConfig(): ClaudeAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.claude");
    return {
        executable: config.get<string>("executable", "claude"),
        model: config.get<string>("model", ""),
        permissionMode: config.get<string>("permissionMode", "default"),
        env: config.get<Record<string, string>>("env", {}),
        playwright: config.get<boolean>("playwright", false),
        mcpServers: config.get<Record<string, unknown>>("mcpServers", {}),
        log: symposiumLog,
    };
}

function copilotConfig(): CopilotAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.copilot");
    return {
        executable: config.get<string>("executable", "copilot"),
        model: config.get<string>("model", ""),
        playwright: config.get<boolean>("playwright", false),
        mcpServers: config.get<Record<string, unknown>>("mcpServers", {}),
    };
}

function codexConfig(): CodexAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.codex");
    return {
        executable: config.get<string>("executable", "codex"),
        model: config.get<string>("model", ""),
        playwright: config.get<boolean>("playwright", false),
        mcpServers: config.get<Record<string, { command?: string; args?: string[] }>>("mcpServers", {}),
    };
}

function symposiumClientInfo(context: vscode.ExtensionContext): NonNullable<OpenAIAdapterConfig["clientInfo"]> {
    const pkg = context.extension.packageJSON as { version?: string };
    const type = os.type();
    const release = os.release();
    const arch = os.arch();
    return {
        id: "symposium-vscode",
        version: String(pkg.version || "unknown"),
        hostname: os.hostname() || "unknown",
        os: `${process.platform}/${arch} (${type} ${release})`,
    };
}

function openaiConfig(context: vscode.ExtensionContext): OpenAIAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.openai");
    return {
        clientInfo: symposiumClientInfo(context),
        api: config.get<"chat" | "responses">("api", "chat"),
        // The built-in "Sufficit AI" backend points at the Sufficit gateway by
        // default and authenticates with the logged-in token — no manual setup.
        baseUrl: config.get<string>("baseUrl", "https://ai.sufficit.com.br/openai/v1"),
        model: config.get<string>("model", ""),
        models: config.get<string[]>("models", []),
        headers: config.get<Record<string, string>>("headers", {}),
        // Gateway auth: explicit openai apiKey, else the static hub token (proven
        // to satisfy the gateway's AIUser policy). Takes precedence over the
        // login token, which may lack the AI claims — guarantees /models + chat
        // work. When neither is set, the login token is used as the fallback.
        apiKey: config.get<string>("apiKey", "") || vscode.workspace.getConfiguration("symposium.hub").get<string>("token", ""),
        maxToolHops: config.get<number>("maxToolHops", 50),
        noProgressStop: config.get<number>("noProgressStop", 0),
        autoCompactAt: config.get<number>("autoCompactAt", 0.8),
        shellExecution: config.get<any>("shellExecution", "silent"),
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
    supportsDeveloperRole?: boolean;
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
function buildCustomAdapters(context: vscode.ExtensionContext, defs: CustomAdapterDef[]): OpenAIAdapter[] {
    return defs.map((def) =>
        new OpenAIAdapter(def.id, def.name || def.id, () => {
            const e = customAdapterDefs().find((x) => x.id === def.id) ?? def;
            return {
                clientInfo: symposiumClientInfo(context),
                api: e.api === "responses" ? "responses" : "chat",
                baseUrl: e.baseUrl,
                model: e.model ?? "",
                models: e.models ?? [],
                headers: e.headers ?? {},
                apiKey: e.apiKey ?? "",
                supportsDeveloperRole: e.supportsDeveloperRole ?? false,
                maxToolHops: vscode.workspace.getConfiguration("symposium.openai").get<number>("maxToolHops", 50),
                noProgressStop: vscode.workspace.getConfiguration("symposium.openai").get<number>("noProgressStop", 0),
                autoCompactAt: vscode.workspace.getConfiguration("symposium.openai").get<number>("autoCompactAt", 0.8),
                shellExecution: vscode.workspace.getConfiguration("symposium.openai").get<any>("shellExecution", "silent"),
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
    const sufficitAdapter = new OpenAIAdapter("openai", "Sufficit AI", () => openaiConfig(context));
    const adapters: AgentAdapter[] = [
        new ClaudeAdapter(claudeConfig),
        new CodexAdapter(codexConfig),
        new CopilotAdapter(copilotConfig),
        sufficitAdapter,
        ...buildCustomAdapters(context, normalizeAdapterDefs()),
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
    // The native "Sufficit AI" backend authenticates with the same login token —
    // so right after login it works with no manual adapter config.
    setOpenAITokenProvider(() => auth.getAccessToken());
    // Verify the Sufficit AI backend in the background (never blocks the UI):
    // on activation/reload and whenever login state changes. Discovery primes
    // the model picker; only warn (non-modal) when logged in but unreachable.
    const checkSufficit = () => {
        void (async () => {
            try {
                const r = await sufficitAdapter.available();
                symposiumLog(`[sufficit-ai] health: ${r.ok ? "ok" : "FAIL " + (r.error ?? "")}`);
                if (!r.ok && (await auth.isLoggedIn())) {
                    void vscode.window.showWarningMessage(`Sufficit AI unavailable: ${r.error ?? "check the connection"}`);
                }
            } catch (e) {
                symposiumLog(`[sufficit-ai] health check error: ${e}`);
            }
        })();
    };
    context.subscriptions.push(auth.onDidChange(checkSufficit));
    checkSufficit();

    // Auto-sync agent knowledge from the hub: pull on activation/reload and
    // whenever login state changes, as long as the user is logged in and the
    // hub is configured. Background, never blocks the UI; the config panel
    // re-scans the local repo afterwards so new agents appear without a manual
    // Sync → Pull. Guarded so overlapping triggers don't run concurrently.
    let autoSyncing = false;
    const autoSync = (reason: string) => {
        void (async () => {
            if (autoSyncing || !api.sync.configured() || !(await auth.isLoggedIn())) { return; }
            autoSyncing = true;
            try {
                const r = await api.sync.pull();
                symposiumLog(`[sync] auto-pull (${reason}): ${JSON.stringify(r)}`);
                ConfigPanel.refresh();
            } catch (e) {
                symposiumLog(`[sync] auto-pull failed (${reason}): ${e}`);
            } finally {
                autoSyncing = false;
            }
        })();
    };
    context.subscriptions.push(auth.onDidChange(() => autoSync("login-change")));
    autoSync("activate");

    // First install: auto-approve agent tool calls so browser/navigation tools
    // don't keep prompting. Set ONCE (a globalState flag) and only if the user
    // hasn't already chosen a value — never override a later opt-out.
    void (async () => {
        const FLAG = "symposium.autoApproveDefaulted";
        if (context.globalState.get<boolean>(FLAG)) { return; }
        const c = vscode.workspace.getConfiguration();
        if (c.inspect("chat.tools.global.autoApprove")?.globalValue === undefined) {
            await c.update("chat.tools.global.autoApprove.optIn", true, vscode.ConfigurationTarget.Global).then(undefined, () => undefined);
            await c.update("chat.tools.global.autoApprove", true, vscode.ConfigurationTarget.Global).then(undefined, () => undefined);
            symposiumLog("[setup] enabled chat.tools.global.autoApprove (first install default)");
        }
        await context.globalState.update(FLAG, true);
    })();

    // Session ids currently being deleted (scrub may run in the background).
    // They are flagged in the list (visual marker) and excluded once gone so
    // a live controller can't re-inject them mid-delete.
    const deleting = new Set<string>();

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
            const liveInfos = runtime.liveInfos();
            const reconciledLive = new Set<string>();
            const disk = store.decorate(await rawSessions(), true)
                .map((s) => {
                    let status = runtime.statusFor(s.sessionId);
                    if (!status) {
                        // Bridge only a BRAND-NEW controller (id not yet assigned,
                        // keyed "new-N") to its freshly-written disk row by cwd.
                        // Previously this also matched any controller-less disk
                        // session to ANY live controller in the same cwd, so a real
                        // working session lit up a sibling session as "working"
                        // (phantom activity). A controller with a real id is already
                        // shown on its own row via statusFor — no cwd guess needed.
                        const byCwd = liveInfos.find((l) =>
                            !reconciledLive.has(l.sessionId)
                            && l.backend === s.backend
                            && !!l.cwd
                            && l.cwd === s.cwd
                            && l.sessionId.startsWith("new-")
                        );
                        if (byCwd) {
                            status = byCwd.status;
                            reconciledLive.add(byCwd.sessionId);
                        }
                    }
                    return { ...s, status };
                });
            const known = new Set(disk.map((s) => s.sessionId));
            const live = liveInfos
                .filter((l) => !known.has(l.sessionId) && !reconciledLive.has(l.sessionId))
                .map((l) => ({ ...l, updatedAt: new Date() } as SessionInfo));
            return [...live, ...disk].map((s) =>
                deleting.has(s.sessionId) ? { ...s, deleting: true } : s);
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
        modelPrefs: {
            getPinned: (backend: string) =>
                context.workspaceState.get<string[]>(`symposium.pinnedModels.${backend}`, []),
            setPinned: (backend: string, models: string[]) =>
                void context.workspaceState.update(`symposium.pinnedModels.${backend}`, models),
            setDefault: (backend: string, model: string | undefined) => {
                // Prefer workspace-scoped settings so different projects can use different
                // default models. Fall back to global when no workspace folder is open
                // (otherwise VS Code throws "Unable to write into workspace settings").
                const target = vscode.workspace.workspaceFolders?.length
                    ? vscode.ConfigurationTarget.Workspace
                    : vscode.ConfigurationTarget.Global;
                return vscode.workspace.getConfiguration(`symposium.${backend}`).update(
                    "model", model || undefined, target);
            },
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

        // Diagnostic: list the VS Code Language Model Tools visible to the
        // in-process backends (so we can confirm the integrated browser /
        // Playwright tools are registered + their exact names).
        vscode.commands.registerCommand("symposium.listLmTools", () => {
            const tools = (vscode as unknown as { lm?: { tools?: ReadonlyArray<{ name: string; tags?: string[] }> } }).lm?.tools ?? [];
            const names = tools.map((t) => t.name).sort();
            symposiumLog(`[lm-tools] ${names.length} tools: ${names.join(", ")}`);
            const browser = names.filter((n) => /browser|playwright|navigate|page/i.test(n));
            void vscode.window.showInformationMessage(
                `LM tools: ${names.length}. Browser-related: ${browser.length ? browser.join(", ") : "(none)"}`,
                "Open Output",
            ).then((p) => { if (p === "Open Output") { output?.show(); } });
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
                if (session) { void vscode.window.showInformationMessage(`Sufficit: signed in as ${session.account.label}.`); }
            } catch (err) {
                void vscode.window.showErrorMessage(`Sufficit login failed: ${err instanceof Error ? err.message : err}`);
            }
        }),
        vscode.commands.registerCommand("symposium.logout", async () => {
            await auth.logout();
            void vscode.window.showInformationMessage("Sufficit: signed out.");
        }),

        vscode.commands.registerCommand("symposium.newSession", async () => {
            const picks = await Promise.all(adapters.map(async (adapter) => {
                const probe = await adapter.available();
                const isEnoent = !probe.ok && /ENOENT|not found/i.test(probe.error ?? "");
                const hasInstall = isEnoent && !!CLI_INSTALL[adapter.backend];
                return {
                    label: adapter.displayName ?? adapter.backend,
                    description: probe.ok ? probe.version : `unavailable: ${probe.error}`,
                    detail: hasInstall ? `$(cloud-download) Click to install via: ${CLI_INSTALL[adapter.backend].cmd}` : undefined,
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
                void promptInstallCli(choice.adapter.backend, choice.label, choice.description ?? "");
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
            const agents = scanKind("agent").filter((a) => readAgentBootstrap(a.name) !== false);
            if (agents.length === 0) {
                void vscode.window.showWarningMessage("No eligible agent in ~/.symposium/repo/agents. Use Seed/Import or create one in Configuration.");
                return;
            }
            const agent = await vscode.window.showQuickPick(
                agents.map((a) => ({ label: a.name, description: a.description, name: a.name })),
                { placeHolder: "Which agent?" });
            if (!agent) {
                return;
            }
            const picks = await Promise.all(adapters.map(async (adapter) => {
                const probe = await adapter.available();
                return { label: adapter.displayName ?? adapter.backend, description: probe.ok ? probe.version : `unavailable: ${probe.error}`, adapter, ok: probe.ok };
            }));
            const choice = await vscode.window.showQuickPick(picks, { placeHolder: `Backend for "${agent.name}"` });
            if (!choice) {
                return;
            }
            if (!choice.ok) {
                void promptInstallCli(choice.adapter.backend, choice.label, choice.description ?? "");
                return;
            }
            const model = await resolveModelPin(choice.adapter, readAgentModel(agent.name));
            const tools = readAgentTools(agent.name);
            const allowedTools = aiToolsForAgent(tools);
            const options: SessionStartOptions = {
                cwd: defaultCwd(),
                developerPrompt: readAgentBody(agent.name),
                aiTools: allowedTools,
                ...(model ? { model } : {}),
            };
            const title = `Agent: ${agent.name}`;
            // Surface will render these as inline meta so we always know which
            // agent is bound to this dialogue, without piggybacking on developerPrompt.
            options.agentName = agent.name;
            options.toolsDeclared = tools;
            options.toolsAllowed = allowedTools;
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
                return { label: adapter.displayName ?? adapter.backend, description: probe.ok ? probe.version : `unavailable: ${probe.error}`, backend: adapter.backend, ok: probe.ok };
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
                const details = JSON.stringify({ action: "deleteSession", backend: info.backend, sessionId: info.sessionId, title: info.title }, null, 2);
                const pick = await vscode.window.showWarningMessage(`Deleting ${info.backend} sessions is not supported.`, "Copy details");
                if (pick === "Copy details") { await vscode.env.clipboard.writeText(details); }
                return;
            }
            // Flag it as deleting BEFORE the confirm modal so the list shows the
            // marker immediately — the modal itself can lag, and the user needs
            // instant feedback that the click registered. Reverted if cancelled.
            deleting.add(info.sessionId);
            refreshAll();
            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete "${info.title}"?\n\nThis scrubs the transcript and all history/index entries for this session (${info.sessionId}) from the ${info.backend} CLI on disk. It cannot be undone.`,
                { modal: true },
                "Delete permanently",
            );
            if (confirm !== "Delete permanently") {
                deleting.delete(info.sessionId);
                refreshAll();
                return;
            }
            runtime.disposeBySessionId(info.sessionId); // stop it if running
            // Close the conversation pane now if it's showing this session.
            chatView.sessionDeleted(info.sessionId);
            ChatPanel.sessionDeleted(info.sessionId);
            refreshAll();
            try {
                snapshots.clearSession(info.sessionId);      // drop in-memory baselines
                const residual = await adapter.deleteSession(info);
                await store.forget(info);
                // Remove the session's tasks from Sufficit memory (soft-delete via
                // expiry) — tasks are bound to the session id.
                let expired = 0;
                try { expired = await expireSessionTasks(new HubClient(), info.sessionId); } catch { /* best-effort */ }
                if (expired) { symposiumLog(`[delete] expired ${expired} memory task(s) for ${info.sessionId}`); }
                if (Array.isArray(residual) && residual.length) {
                    void vscode.window.showWarningMessage(
                        `Session deleted. Residual data may remain in: ${residual.join(", ")} — clear it manually if required.`);
                } else {
                    void vscode.window.showInformationMessage(`Session "${info.title}" permanently deleted.`);
                }
            } catch (error) {
                void showErrorWithCopy(
                    `Delete failed: ${error instanceof Error ? error.message : error}`,
                    JSON.stringify({ action: "deleteSession", backend: info.backend, sessionId: info.sessionId, title: info.title, error: errorDetails(error) }, null, 2),
                );
            } finally {
                // Whether scrub succeeded or failed, stop flagging it; a failed
                // delete reappears (now off disk-or-not per adapter) so the user
                // can retry, a successful one is already gone from disk.
                deleting.delete(info.sessionId);
                refreshAll();
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
                    ? `Symposium: created ${created} example(s) in ~/.symposium/repo.`
                    : "Symposium: examples already existed (nothing created).");
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
