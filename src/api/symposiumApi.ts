import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { AgentAdapter, SessionStartOptions } from "../adapters/types";
import { LiveSessions } from "../sessions/runtime";
import {
    createResource, deleteResource, importSkill, readAgentBody, readAgentTools, readState, readToolCredential,
    ResourceEntry, ResourceKind, rootDir, scanAll, scanForeignSkills, SyncState,
} from "../config/root";
import { aiToolsForAgent } from "../adapters/aiTools";
import { importAgents } from "../config/importAgents";
import { seedExamples } from "../config/seed";
import { HubClient } from "../sync/hubClient";
import { SyncEngine, SyncResult } from "../sync/sync";

/** A session as seen through the public API. */
export interface ApiSessionInfo {
    backend: string;
    sessionId: string;
    title: string;
    cwd: string;
    status: "working" | "idle";
}

export type SendMode = "send" | "queue" | "steer";

/** A backend's health + editable configuration, for the config UI. */
export interface BackendStatus {
    backend: string;
    /** Friendly name shown in the UI (adapter.displayName; falls back to `backend`). */
    displayName: string;
    available: boolean;
    detail: string;
    /** Currently configured model ("" = backend default). */
    model: string;
    /** Models the adapter offers in the picker (first = default). */
    models: string[];
    /** Currently configured executable/command, when applicable. */
    executable?: string;
    /** Whether `executable` is editable (CLI-backed backends). */
    executableEditable: boolean;
    /** Whether `model` is editable here (settings-backed backends). */
    modelEditable: boolean;
    /** True for user-defined OpenAI-compatible endpoints (symposium.adapters),
     *  i.e. not a built-in backend. Such endpoints can be edited/removed in-place. */
    custom: boolean;
}

/** Editable fields of a custom OpenAI-compatible endpoint (symposium.adapters). */
export interface AdapterPatch {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    api?: "chat" | "responses";
}

export interface BackendsApi {
    /** Probes all backends and returns health + editable config. */
    list(): Promise<BackendStatus[]>;
    /** Re-probes a single backend. */
    test(backend: string): Promise<BackendStatus | undefined>;
    /** Persists the model for a backend (global settings). */
    setModel(backend: string, model: string): Promise<boolean>;
    /** Persists the executable for a CLI backend (global settings). */
    setExecutable(backend: string, executable: string): Promise<boolean>;
    /** Appends a new custom OpenAI-compatible endpoint; returns its generated id. */
    addAdapter(patch: AdapterPatch): Promise<string>;
    /** Updates fields of a custom endpoint by id. False if the id is unknown. */
    updateAdapter(id: string, patch: AdapterPatch): Promise<boolean>;
    /** Removes a custom endpoint by id. False if the id is unknown. */
    removeAdapter(id: string): Promise<boolean>;
}

/**
 * Stable, transport-agnostic facade over Symposium's session control, chat
 * stream and local agent knowledge. Exposed in two ways:
 *   - in-process: returned from activate() as the extension's `exports`;
 *   - remotely:   re-published 1:1 by the opt-in HTTP+SSE bridge.
 *
 * It deliberately knows nothing about webviews or HTTP — both transports call
 * the same methods, so remote control and local UI stay in lock-step.
 */
export interface SymposiumApi {
    readonly version: string;

    sessions: {
        /** Live sessions (running or idle) currently managed by Symposium. */
        list(): ApiSessionInfo[];
        /** Live status for a session id. */
        status(id: string): "working" | "idle" | undefined;
        /**
         * Starts a new headless session on a backend. Returns an address (the
         * registry key) usable with send/follow/interrupt immediately, before
         * the backend reports its own session id. When `tools` are given, their
         * vault secrets are resolved and injected into the process env at spawn.
         */
        create(backend: string, options: { cwd: string; model?: string; tools?: string[]; agent?: string }): Promise<string | undefined>;
        /** Sends a message to a session. `steer` interrupts the running turn. */
        send(id: string, text: string, mode?: SendMode): boolean;
        /** Interrupts the running turn, if any. */
        interrupt(id: string): boolean;
        /**
         * Follows a session's render stream (history + live events). Replays the
         * backlog to the observer, then streams new messages. Returns an
         * unsubscribe function, or undefined if the session is unknown.
         */
        follow(id: string, observer: (message: unknown) => void): (() => void) | undefined;
    };

    resources: {
        scan(): Record<ResourceKind, ResourceEntry[]>;
        create(kind: ResourceKind, name: string, description?: string): string;
        remove(kind: ResourceKind, name: string): void;
        /** Writes example resources for offline validation. Returns count created. */
        seed(): number;
        /** Imports CLI agents (.claude/agents, ~/.codex/skills) as agent-defs. */
        importAgents(): { created: number; skipped: number };
        /** Lists importable skill bundles from Claude/Codex dirs. */
        scanForeignSkills(): { source: string; name: string; description: string; path: string }[];
        /** Copies the given skill bundle dirs into repo/skills/. */
        importSkills(srcDirs: string[], overwrite?: boolean): { imported: number; skipped: number; errors: string[] };
        /** Local storage root (~/.symposium by default). */
        root(): string;
    };

    backends: BackendsApi;

    sync: {
        /** Offline-readable sync/health state (state.json). */
        status(): SyncState;
        /** Whether the hub is configured (symposium.hub.url set). */
        configured(): boolean;
        /** Live hub liveness probe (health-gate). */
        health(): Promise<boolean>;
        /** Pull hub → local files (offline-safe). */
        pull(): Promise<SyncResult>;
        /** Push local files → hub (health-gated). */
        push(): Promise<SyncResult>;
    };

    vault: {
        /** Resolves a secret value for runtime injection; null if unknown/expired/offline. */
        resolve(reference: string): Promise<string | null>;
        /**
         * Resolves the env vars for a set of tools (reads each tool's credentialRef
         * + credentialEnv, fetches the secret). Returns the env map plus the refs
         * that could not be resolved (unknown/expired/offline).
         */
        resolveToolEnv(toolNames: string[]): Promise<{ env: Record<string, string>; missing: string[] }>;
    };

    /** Fires when any session starts/stops working or is added/removed. */
    onSessionsChanged: vscode.Event<void>;
}

export interface SymposiumApiDeps {
    live: LiveSessions;
    adapters: AgentAdapter[];
    /** Fires whenever the live session set or status changes. */
    onSessionsChanged: vscode.Event<void>;
}

export const API_VERSION = "1.0.0";

/** CLI-backed backends whose executable + model live in settings. */
const CLI_BACKENDS = new Set(["claude", "codex", "copilot"]);
/** Backends whose model is editable via symposium.<backend>.model. */
const MODEL_BACKENDS = new Set(["claude", "codex", "copilot", "openai"]);
/** Built-in backends; anything else is a user-defined custom endpoint. */
const BUILTIN_BACKENDS = new Set(["claude", "codex", "copilot", "openai"]);

function isModelEditable(backend: string): boolean {
    return MODEL_BACKENDS.has(backend);
}

/** Probes one backend and reads its editable config from settings. */
async function probeBackend(a: AgentAdapter): Promise<BackendStatus> {
    const cfg = vscode.workspace.getConfiguration(`symposium.${a.backend}`);
    let available = false;
    let detail = "";
    try {
        const probe = await a.available();
        available = probe.ok;
        detail = probe.ok ? (probe.version ?? "") : (probe.error ?? "unavailable");
    } catch (err) {
        detail = String(err);
    }
    const custom = !BUILTIN_BACKENDS.has(a.backend);
    return {
        backend: a.backend,
        displayName: a.displayName ?? a.backend,
        available,
        detail,
        // Custom OpenAI-compatible endpoints keep their model in symposium.adapters[].model
        // (not symposium.<id>.model); built-in backends use the per-backend setting.
        model: custom ? (readAdapterDefs().find((d) => d.id === a.backend)?.model ?? "") : cfg.get<string>("model", ""),
        models: a.models ? a.models() : [],
        executable: CLI_BACKENDS.has(a.backend) ? cfg.get<string>("executable", a.backend) : undefined,
        executableEditable: CLI_BACKENDS.has(a.backend),
        // Custom endpoints are model-editable too (their picker writes back into the adapter entry).
        modelEditable: isModelEditable(a.backend) || custom,
        custom,
    };
}

/** Reads the raw symposium.adapters array (custom OpenAI-compatible endpoints). */
function readAdapterDefs(): AdapterEntry[] {
    const arr = vscode.workspace.getConfiguration("symposium").get<AdapterEntry[]>("adapters", []);
    return Array.isArray(arr) ? arr.filter((a) => a && typeof a === "object") : [];
}

async function writeAdapterDefs(defs: AdapterEntry[]): Promise<void> {
    await vscode.workspace.getConfiguration("symposium")
        .update("adapters", defs, vscode.ConfigurationTarget.Global);
}

/** A stored adapter entry (superset of AdapterPatch with its stable id). */
interface AdapterEntry extends AdapterPatch {
    id?: string;
    models?: string[];
    headers?: Record<string, string>;
    supportsDeveloperRole?: boolean;
}

/** Copies only the provided patch fields onto an entry (trims, drops blanks). */
function applyPatch(entry: AdapterEntry, patch: AdapterPatch): void {
    const set = (key: "name" | "baseUrl" | "apiKey" | "model", value: string | undefined) => {
        if (value === undefined) { return; }
        const v = value.trim();
        if (v) { entry[key] = v; } else { delete entry[key]; }
    };
    set("name", patch.name);
    set("baseUrl", patch.baseUrl);
    set("apiKey", patch.apiKey);
    set("model", patch.model);
    if (patch.api === "chat" || patch.api === "responses") { entry.api = patch.api; }
}

/** Builds the public API facade over the running extension state. */
export function createSymposiumApi(deps: SymposiumApiDeps): SymposiumApi {
    const adapterByBackend = new Map(deps.adapters.map((a) => [a.backend, a]));
    const hub = new HubClient();
    const syncEngine = new SyncEngine(hub);

    // Derives a conventional env var name from a vault reference when the tool
    // does not declare credentialEnv (e.g. "anthropic/api_key" → ANTHROPIC_API_KEY).
    const deriveEnv = (ref: string) => ref.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase().replace(/^_+|_+$/g, "");

    const resolveToolEnv = async (toolNames: string[]): Promise<{ env: Record<string, string>; missing: string[] }> => {
        const env: Record<string, string> = {};
        const missing: string[] = [];
        for (const name of toolNames) {
            const { ref, env: envName } = readToolCredential(name);
            if (!ref) {
                continue; // tool needs no secret
            }
            const value = await hub.resolveSecret(ref);
            if (value == null) {
                missing.push(ref);
                continue;
            }
            env[envName || deriveEnv(ref)] = value;
        }
        return { env, missing };
    };

    return {
        version: API_VERSION,

        sessions: {
            list: () => deps.live.liveInfos(),
            status: (id) => deps.live.statusFor(id),
            create: async (backend, options) => {
                const adapter = adapterByBackend.get(backend);
                if (!adapter) {
                    return undefined;
                }
                const opts: SessionStartOptions = { cwd: options.cwd, model: options.model };
                if (options.tools && options.tools.length > 0) {
                    opts.env = (await resolveToolEnv(options.tools)).env;
                }
                // Bind agent-def: gate AI tools + seed the developer prompt.
                if (options.agent) {
                    opts.aiTools = aiToolsForAgent(readAgentTools(options.agent));
                    const dp = readAgentBody(options.agent);
                    if (dp) { opts.developerPrompt = dp; }
                }
                return deps.live.createWithKey(adapter, opts).key;
            },
            send: (id, text, mode = "send") => {
                const c = deps.live.findBySessionId(id);
                if (!c) {
                    return false;
                }
                c.sendText(text, mode);
                return true;
            },
            interrupt: (id) => {
                const c = deps.live.findBySessionId(id);
                if (!c) {
                    return false;
                }
                c.interrupt();
                return true;
            },
            follow: (id, observer) => {
                const c = deps.live.findBySessionId(id);
                return c ? c.subscribe(observer) : undefined;
            },
        },

        resources: {
            scan: () => scanAll(),
            create: (kind, name, description) => createResource(kind, name, description),
            remove: (kind, name) => deleteResource(kind, name),
            seed: () => seedExamples(),
            importAgents: () => importAgents(),
            scanForeignSkills: () => scanForeignSkills(),
            importSkills: (srcDirs, overwrite) => {
                let imported = 0, skipped = 0;
                const errors: string[] = [];
                for (const dir of srcDirs) {
                    const r = importSkill(dir, overwrite);
                    if (r.status === "imported") { imported++; }
                    else if (r.status === "skipped") { skipped++; }
                    else { errors.push(r.name); }
                }
                return { imported, skipped, errors };
            },
            root: () => rootDir(),
        },

        backends: {
            list: () => Promise.all(deps.adapters.map((a) => probeBackend(a))),
            test: async (backend) => {
                const a = adapterByBackend.get(backend);
                return a ? probeBackend(a) : undefined;
            },
            setModel: async (backend, model) => {
                if (!adapterByBackend.has(backend)) {
                    return false;
                }
                // Custom OpenAI-compatible endpoints persist the model into their
                // symposium.adapters[] entry (where buildCustomAdapters reads it),
                // not into a symposium.<id>.model setting that nothing reads.
                if (!BUILTIN_BACKENDS.has(backend)) {
                    const defs = readAdapterDefs();
                    const entry = defs.find((d) => d.id === backend);
                    if (!entry) { return false; }
                    applyPatch(entry, { model });
                    await writeAdapterDefs(defs);
                    return true;
                }
                if (!isModelEditable(backend)) {
                    return false;
                }
                await vscode.workspace.getConfiguration(`symposium.${backend}`)
                    .update("model", model, vscode.ConfigurationTarget.Global);
                return true;
            },
            setExecutable: async (backend, executable) => {
                if (!adapterByBackend.has(backend) || !CLI_BACKENDS.has(backend)) {
                    return false;
                }
                await vscode.workspace.getConfiguration(`symposium.${backend}`)
                    .update("executable", executable, vscode.ConfigurationTarget.Global);
                return true;
            },
            addAdapter: async (patch) => {
                const id = randomUUID().replace(/-/g, "");
                const entry: AdapterEntry = { id };
                applyPatch(entry, patch);
                if (!entry.baseUrl) { entry.baseUrl = ""; }
                await writeAdapterDefs([...readAdapterDefs(), entry]);
                return id;
            },
            updateAdapter: async (id, patch) => {
                const defs = readAdapterDefs();
                const entry = defs.find((d) => d.id === id);
                if (!entry) { return false; }
                applyPatch(entry, patch);
                await writeAdapterDefs(defs);
                return true;
            },
            removeAdapter: async (id) => {
                const defs = readAdapterDefs();
                const next = defs.filter((d) => d.id !== id);
                if (next.length === defs.length) { return false; }
                await writeAdapterDefs(next);
                return true;
            },
        },

        sync: {
            status: () => readState(),
            configured: () => hub.configured(),
            health: () => hub.health(),
            pull: () => syncEngine.pull(),
            push: () => syncEngine.push(),
        },

        vault: {
            resolve: (reference) => hub.resolveSecret(reference),
            resolveToolEnv,
        },

        onSessionsChanged: deps.onSessionsChanged,
    };
}
