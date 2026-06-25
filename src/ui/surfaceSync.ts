import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AgentAdapter, SlashCommand } from "../adapters/types";
import { HubClient } from "../sync/hubClient";
import { fetchSessionTasks, TaskItem } from "../sync/tasks";
import { fetchSessionGuardrails } from "../sync/guardrails";
import { ledgerDir } from "../ledger";

/**
 * Pushes per-session data to the webview panels (tasks, guardrails, models,
 * commands, account) and a couple of related actions (inspect view, attach
 * browser page). Extracted from ChatSurface as a collaborator.
 */
interface SyncController { sessionId?: string; cwd: string; backend: string; }
interface SyncTerminal { backend: string; }

export interface SurfaceSyncDeps {
    post: (message: unknown) => void;
    getController: () => SyncController | undefined;
    getTerminalSession: () => SyncTerminal | undefined;
    getAccount: () => { get(): Promise<unknown> } | undefined;
    setLoggedIn: (v: boolean) => void;
    getCommands: () => SlashCommand[];
}

export class SurfaceSync {
    private readonly hub = new HubClient();

    constructor(private readonly d: SurfaceSyncDeps) { }

    /** Project-local mirror of this session's tasks (in .vscode, versionable). */
    private taskMirrorFile(): string | undefined {
        const cwd = this.d.getController()?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return cwd ? path.join(cwd, ".vscode", "symposium.tasks.json") : undefined;
    }

    /** Loads the session's Sufficit-memory tasks and pushes them to the panel. */
    async refreshTasks(): Promise<void> {
        const sessionId = this.d.getController()?.sessionId ?? "";
        const mirror = this.taskMirrorFile();
        let items: TaskItem[] = [];
        try {
            if (!this.hub.configured() || !sessionId) { throw new Error("no hub/session"); }
            items = await fetchSessionTasks(this.hub, sessionId);
            if (mirror) {
                try {
                    fs.mkdirSync(path.dirname(mirror), { recursive: true });
                    fs.writeFileSync(mirror, JSON.stringify({ sessionId, items }, null, 2), "utf8");
                } catch { /* mirror best-effort */ }
            }
        } catch {
            try {
                const cached = JSON.parse(fs.readFileSync(mirror ?? "", "utf8"));
                items = cached?.sessionId === sessionId ? (cached.items ?? []) : [];
            } catch { items = []; }
        }
        this.d.post({ type: "tasks", items, project: sessionId });
    }

    /** Opens the compact model context or the literal last request as a read-only tab. */
    async openInspectView(target: "context" | "request"): Promise<void> {
        const id = this.d.getController()?.sessionId;
        if (!id) { void vscode.window.showInformationMessage("Open and use a session first."); return; }
        let file: string | undefined;
        if (target === "request") {
            file = path.join(ledgerDir(id), "request-last.json");
        } else {
            const root = path.join(os.homedir(), ".symposium", "sessions");
            try {
                for (const backend of fs.readdirSync(root)) {
                    const f = path.join(root, backend, id + ".json");
                    if (fs.existsSync(f)) { file = f; break; }
                }
            } catch { /* no store */ }
        }
        if (!file || !fs.existsSync(file)) {
            void vscode.window.showInformationMessage(
                "Nothing to inspect yet — send a message first (Sufficit AI / OpenAI backend only).");
            return;
        }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: false });
    }

    /** Pushes the session's user guardrails to the panel. */
    async refreshGuardrails(): Promise<void> {
        const sessionId = this.d.getController()?.sessionId ?? "";
        let items: { id: string; text: string }[] = [];
        try {
            if (this.hub.configured() && sessionId) {
                items = (await fetchSessionGuardrails(this.hub, sessionId)).map((g) => ({ id: g.id, text: g.text }));
            }
        } catch { items = []; }
        this.d.post({ type: "guardrails", items });
    }

    /** Attaches a VS Code integrated-browser page snapshot as a context file. */
    async attachBrowserPage(): Promise<void> {
        const lm = (vscode as unknown as { lm?: { invokeTool?: (n: string, o: unknown, t: unknown) => Promise<{ content: unknown[] }> } }).lm;
        if (!lm?.invokeTool) {
            void vscode.window.showWarningMessage("VS Code does not expose browser tools (open_browser_page) in this version.");
            return;
        }
        const cts = new vscode.CancellationTokenSource();
        try {
            const r = await lm.invokeTool("open_browser_page",
                { input: {}, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<object>, cts.token);
            const content = r.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptPart>;
            const text = content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : "")).join("\n").trim();
            if (!text || /opted not to share|no .*page/i.test(text)) {
                void vscode.window.showInformationMessage("No browser page shared.");
                return;
            }
            const dir = path.join(os.homedir(), ".symposium", "context");
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `browser-page-${Date.now()}.md`);
            fs.writeFileSync(file, "# Browser page (VS Code)\n\n" + text, "utf8");
            this.d.post({ type: "attachments-picked", files: [{ path: file, name: "browser-page.md" }] });
        } catch (err) {
            void vscode.window.showErrorMessage(`Failed to attach the page: ${err instanceof Error ? err.message : err}`);
        } finally {
            cts.dispose();
        }
    }

    /** Fetches the backend's slash commands/skills and sends them for autocomplete. */
    postCommands(adapter: AgentAdapter): void {
        const append = this.d.getCommands();
        if (!adapter.commands) {
            this.d.post({ type: "commands", items: append });
            return;
        }
        void adapter.commands()
            .then((items) => this.d.post({ type: "commands", items: [...items, ...append] }))
            .catch(() => this.d.post({ type: "commands", items: append }));
    }

    /** Async-refreshes remote-discovered models and posts an updated picker list. */
    refreshModels(adapter: AgentAdapter, force = false): void {
        if (!adapter.refreshModels) { return; }
        const backend = adapter.backend;
        void adapter.refreshModels(force)
            .then(({ models, labels }) => {
                const current = this.d.getController()?.backend ?? this.d.getTerminalSession()?.backend;
                if (current !== backend || !models?.length) { return; }
                this.d.post({ type: "models", models, labels: labels ?? {}, refreshed: force });
            })
            .catch(() => undefined);
    }

    /** Pushes the Sufficit account (or null) for the sessions-pane footer. */
    pushAccount(): void {
        const account = this.d.getAccount();
        if (!account) { return; }
        void account.get().then((profile) => {
            this.d.setLoggedIn(!!profile);
            this.d.post({ type: "account", profile: profile ?? null });
        }).catch(() => undefined);
    }
}
