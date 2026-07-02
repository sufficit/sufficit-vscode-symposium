import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { AgentAdapter } from "../adapters/types";

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

/** CLI-backed backends whose executable + model live in settings. */
const CLI_BACKENDS = new Set(["claude", "codex", "copilot"]);
/** Backends whose model is editable via symposium.<backend>.model. */
const MODEL_BACKENDS = new Set(["claude", "codex", "copilot", "openai"]);
/** Built-in backends; anything else is a user-defined custom endpoint. */
const BUILTIN_BACKENDS = new Set(["claude", "codex", "copilot", "openai"]);

function isModelEditable(backend: string): boolean {
    return MODEL_BACKENDS.has(backend);
}

/** A stored adapter entry (superset of AdapterPatch with its stable id). */
interface AdapterEntry extends AdapterPatch {
    id?: string;
    models?: string[];
    headers?: Record<string, string>;
    supportsDeveloperRole?: boolean;
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

/**
 * Builds the `backends` slice of the public API: backend health/config probing
 * and CRUD over custom OpenAI-compatible endpoints (symposium.adapters).
 */
export function createBackendsApi(adapters: AgentAdapter[]): BackendsApi {
    const adapterByBackend = new Map(adapters.map((a) => [a.backend, a]));

    return {
        list: () => Promise.all(adapters.map((a) => probeBackend(a))),
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
    };
}
