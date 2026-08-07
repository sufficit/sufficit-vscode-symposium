import { randomUUID } from "crypto";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ClaudeAdapterConfig } from "../adapters/claude";
import { CodexAdapterConfig } from "../adapters/codex";
import { CopilotAdapterConfig } from "../adapters/copilot";
import { OpenAIAdapter, OpenAIAdapterConfig } from "../adapters/openai";
import type { ShellExecutionMode } from "../adapters/aiTools/types";
import { symposiumLog } from "./log";

/**
 * Working directory for a new session: the workspace folder, else the active
 * editor's folder, else the user's home. Never blocks on "open a folder".
 */
export function defaultCwd(): string {
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

export function claudeConfig(): ClaudeAdapterConfig {
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

export function copilotConfig(): CopilotAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.copilot");
    return {
        executable: config.get<string>("executable", "copilot"),
        model: config.get<string>("model", ""),
        playwright: config.get<boolean>("playwright", false),
        mcpServers: config.get<Record<string, unknown>>("mcpServers", {}),
    };
}

export function codexConfig(): CodexAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.codex");
    return {
        executable: config.get<string>("executable", "codex"),
        model: config.get<string>("model", ""),
        reasoning: config.get<string>("reasoning", "default"),
        approvalPolicy: config.get<string>("approvalPolicy", "default"),
        sandboxMode: config.get<string>("sandboxMode", "workspace-write"),
        workspaceDirs: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
        playwright: config.get<boolean>("playwright", false),
        mcpServers: config.get<Record<string, { command?: string; args?: string[] }>>(
            "mcpServers",
            {},
        ),
    };
}

export function symposiumClientInfo(
    context: vscode.ExtensionContext,
): NonNullable<OpenAIAdapterConfig["clientInfo"]> {
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

export function openaiConfig(context: vscode.ExtensionContext): OpenAIAdapterConfig {
    const config = vscode.workspace.getConfiguration("symposium.openai");
    return {
        clientInfo: symposiumClientInfo(context),
        // The Sufficit gateway and current reasoning models support the Responses
        // API. It is required when a turn combines tools with reasoning effort.
        // Users can still explicitly select legacy chat/completions in settings.
        api: config.get<"chat" | "responses">("api", "responses"),
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
        apiKey:
            config.get<string>("apiKey", "") ||
            vscode.workspace.getConfiguration("symposium.hub").get<string>("token", ""),
        maxToolHops: config.get<number>("maxToolHops", 50),
        noProgressStop: config.get<number>("noProgressStop", 0),
        autoCompactAt: config.get<number>("autoCompactAt", 0.8),
        autoCompactOnTasksComplete: config.get<boolean>("autoCompactOnTasksComplete", true),
        maxHistoryMessages: config.get<number>("maxHistoryMessages", 40),
        shellExecution: config.get<ShellExecutionMode>("shellExecution", "silent"),
        timeGapNotice: config.get<string>("timeGapNotice", "5m"),
        permissionMode: config.get<string>("permissionMode", "admin"),
        log: symposiumLog,
    };
}

export interface CustomAdapterDef {
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

const BUILTIN_MODEL_BACKENDS = new Set(["claude", "codex", "copilot", "openai"]);

/** Reads the user's extra OpenAI-compatible adapters (symposium.adapters). */
export function customAdapterDefs(): CustomAdapterDef[] {
    const arr = vscode.workspace
        .getConfiguration("symposium")
        .get<CustomAdapterDef[]>("adapters", []);
    return Array.isArray(arr) ? arr.filter((a) => a && a.id && a.baseUrl) : [];
}

/** Reads the configured default model from the same store used by the adapter. */
export function configuredModel(backend: string): string {
    if (!BUILTIN_MODEL_BACKENDS.has(backend)) {
        return customAdapterDefs().find((entry) => entry.id === backend)?.model ?? "";
    }
    return vscode.workspace.getConfiguration(`symposium.${backend}`).get<string>("model", "");
}

/**
 * Persists a chat-picker default model. Custom adapters are entries in the
 * shared `symposium.adapters` array; they do not have a `symposium.<id>`
 * configuration namespace.
 */
export async function setConfiguredModel(
    backend: string,
    model: string | undefined,
    target: vscode.ConfigurationTarget,
): Promise<void> {
    if (BUILTIN_MODEL_BACKENDS.has(backend)) {
        await vscode.workspace
            .getConfiguration(`symposium.${backend}`)
            .update("model", model || undefined, target);
        return;
    }

    const config = vscode.workspace.getConfiguration("symposium");
    const defs = config.get<CustomAdapterDef[]>("adapters", []);
    const index = Array.isArray(defs) ? defs.findIndex((entry) => entry?.id === backend) : -1;
    if (index < 0) {
        return;
    }

    const next = defs.map((entry, i) => {
        if (i !== index) {
            return entry;
        }
        const updated = { ...entry };
        const value = model?.trim();
        if (value) {
            updated.model = value;
        } else {
            delete updated.model;
        }
        return updated;
    });
    await config.update("adapters", next, target);
}

/**
 * Human label for an OpenAI-compatible adapter, shown in the New Session picker,
 * the chat header and the config UI. Prefers the explicit `name`; otherwise
 * derives a readable host/path from `baseUrl` so an unnamed endpoint never
 * surfaces its opaque GUID id (which is meaningless to the user).
 */
export function adapterLabel(def: { name?: string; baseUrl?: string; id?: string }): string {
    const name = def.name?.trim();
    if (name) {
        return name;
    }
    const fromUrl = labelFromBaseUrl(def.baseUrl);
    return fromUrl || def.id || "endpoint";
}

/** "https://ai.sufficit.com.br/openai/v1" → "ai.sufficit.com.br/openai/v1". */
export function labelFromBaseUrl(baseUrl?: string): string {
    const raw = baseUrl?.trim();
    if (!raw) {
        return "";
    }
    try {
        const u = new URL(raw);
        const p = u.pathname.replace(/\/+$/, "");
        return p && p !== "/" ? `${u.host}${p}` : u.host;
    } catch {
        return raw.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
    }
}

/**
 * Ensures every adapter has a stable id (so renaming `name` never breaks its
 * sessions). Missing ids get an auto-generated GUID without hyphens; manual ids
 * in any format are kept. Persists generated ids back to settings.json.
 */
export function normalizeAdapterDefs(): CustomAdapterDef[] {
    const cfg = vscode.workspace.getConfiguration("symposium");
    const arr = (cfg.get<CustomAdapterDef[]>("adapters", []) ?? []).filter((a) => a && a.baseUrl);
    let changed = false;
    for (const a of arr) {
        if (!a.id) {
            a.id = randomUUID().replace(/-/g, "");
            changed = true;
        }
    }
    if (changed) {
        void cfg.update("adapters", arr, vscode.ConfigurationTarget.Global);
    }
    return arr;
}

/** One OpenAIAdapter per custom def, re-reading its entry live by id. */
export function buildCustomAdapters(
    context: vscode.ExtensionContext,
    defs: CustomAdapterDef[],
): OpenAIAdapter[] {
    return defs.map(
        (def) =>
            new OpenAIAdapter(def.id, adapterLabel(def), () => {
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
                    maxToolHops: vscode.workspace
                        .getConfiguration("symposium.openai")
                        .get<number>("maxToolHops", 50),
                    noProgressStop: vscode.workspace
                        .getConfiguration("symposium.openai")
                        .get<number>("noProgressStop", 0),
                    autoCompactAt: vscode.workspace
                        .getConfiguration("symposium.openai")
                        .get<number>("autoCompactAt", 0.8),
                    autoCompactOnTasksComplete: vscode.workspace
                        .getConfiguration("symposium.openai")
                        .get<boolean>("autoCompactOnTasksComplete", true),
                    maxHistoryMessages: vscode.workspace
                        .getConfiguration("symposium.openai")
                        .get<number>("maxHistoryMessages", 40),
                    shellExecution: vscode.workspace
                        .getConfiguration("symposium.openai")
                        .get<ShellExecutionMode>("shellExecution", "silent"),
                    timeGapNotice: vscode.workspace
                        .getConfiguration("symposium.openai")
                        .get<string>("timeGapNotice", "5m"),
                    permissionMode: vscode.workspace
                        .getConfiguration("symposium.openai")
                        .get<string>("permissionMode", "admin"),
                    log: symposiumLog,
                };
            }),
    );
}
