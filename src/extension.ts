import * as vscode from "vscode";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { CopilotAdapter } from "./adapters/copilot";
import { OpenAIAdapter, setOpenAITokenProvider } from "./adapters/openai";
import { AgentAdapter, SessionInfo } from "./adapters/types";
import { SessionStore } from "./sessions/store";
import { SessionIndex } from "./sessions/index";
import { LiveSessions } from "./sessions/runtime";
import { SubagentManager } from "./sessions/subagents";
import { setSubagentHost, setLiveTranscriptReader } from "./adapters/aiTools";
import { ChatPanel } from "./ui/chatPanel";
import { ChatViewProvider } from "./ui/chatView";
import { ConfigPanel } from "./ui/configPanel";
import { createSymposiumApi, SymposiumApi } from "./api/symposiumApi";
import { RemoteBridge } from "./api/bridge";
import { SufficitAuth } from "./auth/identity";
import { SufficitAuthProvider } from "./auth/provider";
import { setHubTokenProvider, HubClient } from "./sync/hubClient";
import { ensureTailnetJoined } from "./net/tailnet";
import { symposiumLog, setSymposiumOutput } from "./extension/log";
import { claudeConfig, codexConfig, copilotConfig, openaiConfig, normalizeAdapterDefs, buildCustomAdapters } from "./extension/config";
import { buildChatSurfaceDeps } from "./extension/surfaceDeps";
import { registerCommands } from "./extension/commands";
import { initSttStorage } from "./voice/sttService";
import { initVscodeSpeechBridge } from "./voice/vscodeSpeechBridge";
import { setCodexSufficitTokenProvider, syncCodexSufficitMcp } from "./adapters/codex/sufficitMcp";

// Re-exported so consumers (e.g. ui/chatSurface) can keep importing from here.
export { symposiumLog } from "./extension/log";

export function activate(context: vscode.ExtensionContext): SymposiumApi {
    const output = vscode.window.createOutputChannel("Symposium");
    setSymposiumOutput(output);
    context.subscriptions.push(output);

    // Local speech-to-text model storage (downloaded on demand under global storage).
    initSttStorage(context);
    initVscodeSpeechBridge(context.globalStorageUri.fsPath);

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
    const sessionIndex = new SessionIndex({
        storageDir: context.globalStorageUri.fsPath,
        adapters,
        log: symposiumLog,
    });
    context.subscriptions.push(sessionIndex);

    // Live backend registry: when the user adds/imports/removes a custom backend
    // (symposium.adapters), rebuild the custom adapters IN PLACE so they're usable
    // immediately — no window reload. Built-ins (claude/codex/copilot/openai) stay.
    const BUILTIN_BACKENDS = new Set(["claude", "codex", "copilot", "openai"]);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("symposium.adapters")) { return; }
        const defs = normalizeAdapterDefs();
        const wantIds = new Set(defs.map((d) => d.id));
        for (let i = adapters.length - 1; i >= 0; i--) {
            const id = adapters[i].backend;
            if (!BUILTIN_BACKENDS.has(id) && !wantIds.has(id)) {
                adapters.splice(i, 1);
                adapterByBackend.delete(id);
            }
        }
        const have = new Set(adapters.map((a) => a.backend));
        for (const ad of buildCustomAdapters(context, defs)) {
            if (!have.has(ad.backend)) {
                adapters.push(ad);
                adapterByBackend.set(ad.backend, ad);
            }
        }
        symposiumLog(`[adapters] rebuilt custom backends live (${adapters.length} total)`);
    }));

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

    // Subagent host: lets the native Sufficit AI backend delegate to other
    // agent-defs as real sessions (spawn_agent / agent_* tools). Late-bound so
    // the low-level tool layer never imports the runtime directly.
    setSubagentHost(new SubagentManager(runtime, adapterByBackend,
        () => vscode.workspace.getConfiguration("symposium.subagents").get<number>("timeoutMs", 300000)));
    context.subscriptions.push({ dispose: () => setSubagentHost(undefined) });

    // Live transcript reader: lets read_session pull a running session's freshest
    // transcript from its controller before any ledger/store flush. Late-bound so
    // the tool layer never imports the runtime.
    setLiveTranscriptReader({ read: (id) => runtime.readTranscript(id) });
    context.subscriptions.push({ dispose: () => setLiveTranscriptReader(undefined) });

    // Sufficit Identity login (tokens in SecretStorage; basis for memory/MCP).
    const auth = new SufficitAuth(context, symposiumLog);
    context.subscriptions.push(auth.onDidChange(() => ConfigPanel.refresh()));
    context.subscriptions.push({ dispose: () => auth.dispose() });
    void auth.startAutoRefresh();   // silent token refresh so the session never lapses
    // Plug the Sufficit token into the Codex MCP sufficit_ai server automatically.
    setCodexSufficitTokenProvider((forceRefresh) => auth.getAccessToken(forceRefresh));
    context.subscriptions.push(auth.onDidChange(async () => { await syncCodexSufficitMcp(); }));
    void syncCodexSufficitMcp();
    // Native Accounts-menu integration (avatar/login at the bottom of the activity bar).
    SufficitAuthProvider.register(context, auth);
    // Hub/MCP requests use the logged-in identity token when available.
    setHubTokenProvider(() => auth.getAccessToken());
    // The native "Sufficit AI" backend authenticates with the same login token —
    // so right after login it works with no manual adapter config.
    setOpenAITokenProvider((forceRefresh) => auth.getAccessToken(forceRefresh));
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

    // Join the Sufficit tailnet (self-hosted Headscale) so Symposium's remote bridge is
    // reachable without manual NAT/port-forward setup. Background, best-effort — see
    // net/tailnet.ts for why login failures here must never surface to the user.
    const joinTailnet = (reason: string) => {
        void (async () => {
            if (!(await auth.isLoggedIn())) { return; }
            await ensureTailnetJoined(new HubClient(), (msg) => symposiumLog(`${msg} (${reason})`));
        })();
    };
    context.subscriptions.push(auth.onDidChange(() => joinTailnet("login-change")));
    joinTailnet("activate");

    // First install: offer to auto-approve agent tool calls so browser/navigation
    // tools don't keep prompting. Ask ONCE (a globalState flag), only if the user
    // hasn't already chosen a value, and only write the setting on explicit
    // consent — it auto-approves ALL chat tools editor-wide, including terminal.
    void (async () => {
        const FLAG = "symposium.autoApproveDefaulted";
        if (context.globalState.get<boolean>(FLAG)) { return; }
        const c = vscode.workspace.getConfiguration();
        if (c.inspect("chat.tools.global.autoApprove")?.globalValue === undefined) {
            const choice = await vscode.window.showWarningMessage(
                "Symposium: enable auto-approve for chat agent tool calls (chat.tools.global.autoApprove)? This applies to ALL chat extensions and includes terminal commands.",
                "Yes", "No");
            if (choice === "Yes") {
                await c.update("chat.tools.global.autoApprove.optIn", true, vscode.ConfigurationTarget.Global).then(undefined, () => undefined);
                await c.update("chat.tools.global.autoApprove", true, vscode.ConfigurationTarget.Global).then(undefined, () => undefined);
                symposiumLog("[setup] enabled chat.tools.global.autoApprove (user consented)");
            }
        }
        // Dismissing counts as "No": consent was not given, don't nag again.
        await context.globalState.update(FLAG, true);
    })();

    // Session ids currently being deleted (scrub may run in the background).
    // They are flagged in the list (visual marker) and excluded once gone so
    // a live controller can't re-inject them mid-delete.
    const deleting = new Set<string>();

    let indexPrimed = sessionIndex.listCached().length > 0;
    let lastReconcileAt = 0;
    const RECONCILE_INTERVAL_MS = 5_000;
    const rawSessions = (): Promise<SessionInfo[]> => {
        const cached = sessionIndex.listCached();
        if (indexPrimed) {
            // Stale-while-revalidate: startup and every surface receive the
            // persisted snapshot immediately. Throttled provider reconciliation
            // stays off the UI path and remains single-flight inside SessionIndex.
            if (Date.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
                lastReconcileAt = Date.now();
                void sessionIndex.reconcile();
            }
            return Promise.resolve(cached);
        }
        // First run has no snapshot to show. Await one shared bootstrap pass;
        // subsequent reloads are served entirely from globalStorage.
        lastReconcileAt = Date.now();
        return sessionIndex.reconcile().then((sessions) => {
            indexPrimed = true;
            return sessions;
        });
    };

    const surfaceDeps = buildChatSurfaceDeps({ context, runtime, store, adapterByBackend, auth, deleting, rawSessions });
    const chatView = new ChatViewProvider(surfaceDeps);

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

    // Opt-in remote control bridge (off unless symposium.bridge.enabled).
    const bridge = new RemoteBridge(api, (msg) => output.appendLine(msg));
    void bridge.start();
    context.subscriptions.push({ dispose: () => bridge.stop() });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("symposium.bridge")) { return; }
        bridge.stop();
        void (async () => {
            const url = await bridge.start();
            output.appendLine(url
                ? `[bridge] configuration changed; restarted on ${url}`
                : "[bridge] configuration changed; bridge is disabled");
        })();
    }));

    registerCommands({
        context, adapters, adapterByBackend, surfaceDeps, chatView,
        runtime, store, api, auth, bridge, deleting, refreshAll, output,
    });

    return api;
}

export function deactivate(): void { }
