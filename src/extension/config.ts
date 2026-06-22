import { randomUUID } from "crypto";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ClaudeAdapterConfig } from "../adapters/claude";
import { CodexAdapterConfig } from "../adapters/codex";
import { CopilotAdapterConfig } from "../adapters/copilot";
import { OpenAIAdapter, OpenAIAdapterConfig } from "../adapters/openai";
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
        playwright: config.get<boolean>("playwright", false),
        mcpServers: config.get<Record<string, { command?: string; args?: string[] }>>("mcpServers", {}),
    };
}

export function symposiumClientInfo(context: vscode.ExtensionContext): NonNullable<OpenAIAdapterConfig["clientInfo"]> {
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

/** Reads the user's extra OpenAI-compatible adapters (symposium.adapters). */
export function customAdapterDefs(): CustomAdapterDef[] {
    const arr = vscode.workspace.getConfiguration("symposium").get<CustomAdapterDef[]>("adapters", []);
    return Array.isArray(arr) ? arr.filter((a) => a && a.id && a.baseUrl) : [];
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
        if (!a.id) { a.id = randomUUID().replace(/-/g, ""); changed = true; }
    }
    if (changed) { void cfg.update("adapters", arr, vscode.ConfigurationTarget.Global); }
    return arr;
}

/** One OpenAIAdapter per custom def, re-reading its entry live by id. */
export function buildCustomAdapters(context: vscode.ExtensionContext, defs: CustomAdapterDef[]): OpenAIAdapter[] {
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
