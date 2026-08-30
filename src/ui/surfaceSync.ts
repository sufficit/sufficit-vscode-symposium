import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AgentAdapter, SlashCommand } from "../adapters/types";
import { HubClient, Observation } from "../sync/hubClient";
import { fetchSessionTasks, TaskItem } from "../sync/tasks";
import { applyTaskState, reconcileTaskStateOverrides, TaskStateOverride } from "../sync/taskUi";
import { loadSurfaceGuardrails } from "./surfaceGuardrails";
import { ledgerDir } from "../ledger";
import { attachBrowserPage } from "./surfaceBrowserAttachment";

/**
 * Pushes per-session data to the webview panels (tasks, guardrails, models,
 * commands, account) and a couple of related actions (inspect view, attach
 * browser page). Extracted from ChatSurface as a collaborator.
 */
interface SyncController {
    sessionId?: string;
    cwd: string;
    backend: string;
}
interface SyncTerminal {
    backend: string;
}

export interface SurfaceSyncDeps {
    post: (message: unknown) => void;
    getController: () => SyncController | undefined;
    getTerminalSession: () => SyncTerminal | undefined;
    getAccount: () => { get(force?: boolean): Promise<unknown> } | undefined;
    setLoggedIn: (v: boolean) => void;
    getCommands: () => SlashCommand[];
}

export class SurfaceSync {
    private readonly hub = new HubClient();
    // Last-known panel state, kept so a just-created item can be merged in
    // optimistically (read-by-id is instant and doesn't depend on the hub's
    // async search index settling) instead of waiting for searchMemory to see it.
    private lastTasks: TaskItem[] = [];
    private lastGuardrails: { id: string; text: string }[] = [];
    // Session id the caches belong to; on change the optimistic cache is dropped
    // so items from a previous session never leak into the panel.
    private lastSessionId = "";
    // First-seen time per cached task id, so a missing-from-fetch item is only
    // kept for a short grace window (index lag), not forever — otherwise a
    // genuinely expired/cleared task becomes a permanent ghost in the panel
    // (list_tasks reads the hub fresh and correctly shows it gone; the panel
    // must eventually agree, not just optimistically diverge).
    private taskFirstSeenAtMs = new Map<string, number>();
    // Completion/reopen writes are immediately known by exact id, while the
    // search index can briefly return the previous state. Keep that exact state
    // authoritative until search catches up (same anti-lag principle as creates).
    private taskStateOverrides = new Map<string, TaskStateOverride>();
    // 5s was too short in practice: the hub's search index can lag well past
    // that under load, so a just-created task dropped out of the grace window
    // before search ever caught up — it never reappeared. A missed task is far
    // more disruptive than a cleared one lingering a bit longer, so this errs
    // long; refreshTasks() re-includes it normally the moment search catches up.
    private static readonly TASK_GHOST_GRACE_MS = 60_000;

    constructor(private readonly d: SurfaceSyncDeps) {}

    /** Project-local mirror of this session's tasks (in .vscode, versionable). */
    private taskMirrorFile(): string | undefined {
        const cwd =
            this.d.getController()?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return cwd ? path.join(cwd, ".vscode", "symposium.tasks.json") : undefined;
    }

    /** Loads the session's Sufficit-memory tasks and pushes them to the panel. */
    async refreshTasks(): Promise<void> {
        const sessionId = this.d.getController()?.sessionId ?? "";
        if (sessionId !== this.lastSessionId) {
            this.lastSessionId = sessionId;
            this.lastTasks = [];
            this.lastGuardrails = [];
            this.taskFirstSeenAtMs.clear();
            this.taskStateOverrides.clear();
        }
        const mirror = this.taskMirrorFile();
        let items: TaskItem[] = [];
        try {
            if (!this.hub.configured() || !sessionId) {
                throw new Error("no hub/session");
            }
            items = await fetchSessionTasks(this.hub, sessionId);
            items = reconcileTaskStateOverrides(
                items,
                this.taskStateOverrides,
                Date.now(),
                SurfaceSync.TASK_GHOST_GRACE_MS,
            );
            if (mirror) {
                try {
                    fs.mkdirSync(path.dirname(mirror), { recursive: true });
                    fs.writeFileSync(mirror, JSON.stringify({ sessionId, items }, null, 2), "utf8");
                } catch {
                    /* mirror best-effort */
                }
            }
        } catch {
            try {
                const cached = JSON.parse(fs.readFileSync(mirror ?? "", "utf8"));
                items = cached?.sessionId === sessionId ? (cached.items ?? []) : [];
            } catch {
                items = [];
            }
        }
        // Merge rather than overwrite: the search endpoint is async-indexed, so a
        // task added moments ago (already shown optimistically by bumpTasksByIds)
        // can be briefly missing from `items`. A missing id is treated as
        // "not indexed yet" only within a short grace window from when it was
        // first seen — past that, the fresh fetch is trusted as authoritative
        // (the task really is gone: expired, cleared, or never existed here).
        const now = Date.now();
        const have = new Set(items.map((t) => t.id));
        for (const t of items) {
            if (!this.taskFirstSeenAtMs.has(t.id)) {
                this.taskFirstSeenAtMs.set(t.id, now);
            }
        }
        const stillInGrace = this.lastTasks.filter((t) => {
            if (have.has(t.id)) {
                return false;
            }
            const firstSeen = this.taskFirstSeenAtMs.get(t.id);
            return firstSeen != null && now - firstSeen < SurfaceSync.TASK_GHOST_GRACE_MS;
        });
        const merged = [...items, ...stillInGrace];
        // Drop bookkeeping for ids no longer present anywhere (expired grace or truly gone).
        const keepIds = new Set(merged.map((t) => t.id));
        for (const id of Array.from(this.taskFirstSeenAtMs.keys())) {
            if (!keepIds.has(id)) {
                this.taskFirstSeenAtMs.delete(id);
            }
        }
        this.lastTasks = merged;
        this.d.post({ type: "tasks", items: merged, project: sessionId });
    }

    /** Updates a completed/reopened task immediately, then reconciles via search. */
    setTasksDoneByIds(ids: string[], done: boolean): void {
        const exact = [...new Set(ids.filter(Boolean))];
        if (!exact.length) {
            void this.refreshTasks();
            return;
        }
        const now = Date.now();
        for (const id of exact) {
            this.taskStateOverrides.set(id, { done, at: now });
        }
        this.lastTasks = applyTaskState(this.lastTasks, exact, done);
        const sessionId = this.d.getController()?.sessionId ?? "";
        this.d.post({ type: "tasks", items: this.lastTasks, project: sessionId });
        void this.refreshTasks();
    }

    /**
     * Optimistic, index-latency-proof refresh: a freshly created task is read
     * directly by its id (instant, deterministic) and merged into the panel,
     * so it shows the moment add_task returns — without waiting for the hub's
     * async search index to pick it up. Falls back to a full refresh.
     */
    async bumpTasksByIds(ids: string[]): Promise<void> {
        if (!ids.length) {
            return this.refreshTasks();
        }
        try {
            if (!this.hub.configured()) {
                return this.refreshTasks();
            }
            const obs = await this.hub.getByIds(ids);
            const created: TaskItem[] = obs
                .filter((o) => o && o.id)
                .map((o) => ({
                    id: String(o.id),
                    type: o.type ?? "task-anchor",
                    title: o.title ?? "",
                    summary: o.summary ?? "",
                    ts: String(
                        (o as Observation & { createdAtUtc?: string }).createdAtUtc ?? Date.now(),
                    ),
                    tags: o.tags ?? "",
                    done: String(o.tags ?? "")
                        .split(",")
                        .map((t) => t.trim())
                        .includes("status:done"),
                }));
            if (!created.length) {
                return this.refreshTasks();
            }
            // Merge: prepend new ones not already present, keep order stable.
            const have = new Set(this.lastTasks.map((t) => t.id));
            const merged = [...created.filter((t) => !have.has(t.id)), ...this.lastTasks];
            const now = Date.now();
            for (const t of created) {
                if (!this.taskFirstSeenAtMs.has(t.id)) {
                    this.taskFirstSeenAtMs.set(t.id, now);
                }
            }
            this.lastTasks = merged;
            const sessionId = this.d.getController()?.sessionId ?? "";
            this.d.post({ type: "tasks", items: merged, project: sessionId });
        } catch {
            // getByIds can fail on an older hub; fall back to the search path.
            return this.refreshTasks();
        }
        // Best-effort: let the canonical search-based refresh reconcile later.
        void this.refreshTasks();
    }

    /** Opens the compact model context or the literal last request as a read-only tab. */
    async openInspectView(target: "context" | "request"): Promise<void> {
        const id = this.d.getController()?.sessionId;
        if (!id) {
            void vscode.window.showInformationMessage("Open and use a session first.");
            return;
        }
        let file: string | undefined;
        if (target === "request") {
            file = path.join(ledgerDir(id), "request-last.json");
        } else {
            const root = path.join(os.homedir(), ".symposium", "sessions");
            try {
                for (const backend of fs.readdirSync(root)) {
                    const f = path.join(root, backend, id + ".json");
                    if (fs.existsSync(f)) {
                        file = f;
                        break;
                    }
                }
            } catch {
                /* no store */
            }
        }
        if (!file || !fs.existsSync(file)) {
            void vscode.window.showInformationMessage(
                "Nothing to inspect yet — send a message first (Sufficit AI / OpenAI backend only).",
            );
            return;
        }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), {
            preview: false,
        });
    }

    /** Pushes the session's user guardrails to the panel. */
    async refreshGuardrails(): Promise<void> {
        const sessionId = this.d.getController()?.sessionId ?? "";
        const items = await loadSurfaceGuardrails(this.hub, sessionId, this.lastGuardrails);
        this.lastGuardrails = items;
        this.d.post({ type: "guardrails", items });
    }

    /**
     * Optimistic refresh of a just-added guardrail (read-by-id, instant; does
     * not depend on the hub's async search index). Falls back to a full refresh.
     * Pass source: "local" when add_guardrail fell back to LocalMemory so we read
     * from there instead of the hub.
     */
    async bumpGuardrailById(id: string, source?: "hub" | "local"): Promise<void> {
        if (!id) {
            return this.refreshGuardrails();
        }
        try {
            let obs: Observation | undefined;
            if (source === "local") {
                const { LocalMemory } = await import("../adapters/aiTools/localMemory");
                const [o] = await new LocalMemory().getByIds([id]);
                obs = o;
            } else {
                if (!this.hub.configured()) {
                    return this.refreshGuardrails();
                }
                [obs] = await this.hub.getByIds([id]);
            }
            if (!obs || !obs.id) {
                return this.refreshGuardrails();
            }
            const created = { id: String(obs.id), text: obs.summary || obs.title || "" };
            const have = new Set(this.lastGuardrails.map((g) => g.id));
            const merged = have.has(created.id)
                ? this.lastGuardrails
                : [...this.lastGuardrails, created];
            this.lastGuardrails = merged;
            this.d.post({ type: "guardrails", items: merged });
        } catch {
            return this.refreshGuardrails();
        }
        // Reconcile via search (hub only; local-only guardrails stay in the
        // optimistic merge above and are re-read on session reopen).
        if (source !== "local") {
            void this.refreshGuardrails();
        }
    }

    /** Attaches a VS Code integrated-browser page snapshot as a context file. */
    async attachBrowserPage(): Promise<void> {
        await attachBrowserPage(this.d.post);
    }

    /** Fetches the backend's slash commands/skills and sends them for autocomplete. */
    postCommands(adapter: AgentAdapter): void {
        const append = this.d.getCommands();
        if (!adapter.commands) {
            this.d.post({ type: "commands", items: append });
            return;
        }
        void adapter
            .commands()
            .then((items) => this.d.post({ type: "commands", items: [...items, ...append] }))
            .catch(() => this.d.post({ type: "commands", items: append }));
    }

    /** Async-refreshes remote-discovered models and posts an updated picker list. */
    refreshModels(adapter: AgentAdapter, force = false): void {
        if (!adapter.refreshModels) {
            return;
        }
        const backend = adapter.backend;
        void adapter
            .refreshModels(force)
            .then(({ models, labels }) => {
                const current =
                    this.d.getController()?.backend ?? this.d.getTerminalSession()?.backend;
                if (current !== backend) {
                    return;
                }
                // Post even on an empty result for an EXPLICIT refresh, so the
                // picker shows feedback instead of looking dead; a background
                // (non-forced) refresh stays silent on empty to avoid clobbering.
                if (models?.length || force) {
                    this.d.post({
                        type: "models",
                        models: models ?? [],
                        labels: labels ?? {},
                        refreshed: force,
                    });
                }
            })
            .catch(() => {
                if (force) {
                    this.d.post({ type: "models", models: [], labels: {}, refreshed: force });
                }
            });
    }

    /** Pushes the Sufficit account (or null) for the sessions-pane footer. */
    pushAccount(): void {
        const account = this.d.getAccount();
        if (!account) {
            return;
        }
        void account
            .get()
            .then((profile) => {
                // If the profile came back empty on the (non-force) read, the token
                // refresh may still be in flight — a common race right after window
                // load that leaves the footer stuck on "Entrar na Sufficit" even
                // though the user is logged in. Force a fresh profile fetch before
                // settling on logged-out, so a transient null self-corrects without
                // waiting for (or missing) a later onDidChange.
                if (profile) {
                    this.d.setLoggedIn(true);
                    this.d.post({ type: "account", profile });
                    return;
                }
                void account
                    .get(true)
                    .then((forced) => {
                        const final = forced ?? null;
                        this.d.setLoggedIn(!!forced);
                        this.d.post({ type: "account", profile: final });
                    })
                    .catch(() => {
                        this.d.setLoggedIn(false);
                        this.d.post({ type: "account", profile: null });
                    });
            })
            .catch(() => undefined);
    }
}
