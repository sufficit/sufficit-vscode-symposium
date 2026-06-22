import * as cp from "child_process";
import * as vscode from "vscode";
import { AgentAdapter, SessionInfo } from "../../adapters/types";
import { SessionStore } from "../../sessions/store";
import { LiveSessions } from "../../sessions/runtime";
import { ChatPanel } from "../../ui/chatPanel";
import { ChatSurfaceDeps } from "../../ui/chatSurface";
import { ChatViewProvider } from "../../ui/chatView";
import { SymposiumApi } from "../../api/symposiumApi";
import { RemoteBridge } from "../../api/bridge";
import { SufficitAuth } from "../../auth/identity";
import { claudeConfig, codexConfig, copilotConfig } from "../config";

/** A tmux-backed persistent terminal session (survives VS Code quit). */
export interface PersistEntry { tmuxName: string; backend: string; cwd: string; title: string; }

/** Raw wiring passed from activate() to the command registrars. */
export interface CommandDeps {
    context: vscode.ExtensionContext;
    adapters: AgentAdapter[];
    adapterByBackend: Map<string, AgentAdapter>;
    surfaceDeps: ChatSurfaceDeps;
    chatView: ChatViewProvider;
    runtime: LiveSessions;
    store: SessionStore;
    api: SymposiumApi;
    auth: SufficitAuth;
    bridge: RemoteBridge;
    deleting: Set<string>;
    refreshAll: () => void;
    output: vscode.OutputChannel;
}

/** Shared helpers derived from the deps, reused across command groups. */
export interface CommandHelpers {
    infoOf: (item: { info?: SessionInfo } | SessionInfo) => SessionInfo;
    inEditor: () => boolean;
    startTerminal: (backend: string, options: { cwd: string; resumeSessionId?: string; tmuxName?: string }, title: string) => void;
    persistKey: string;
    persistGet: () => PersistEntry[];
    persistAdd: (e: PersistEntry) => Thenable<void>;
    tmuxAlive: (name: string) => Promise<boolean>;
}

export type CommandContext = CommandDeps & CommandHelpers;

/** Builds the shared command helpers from the raw activation deps. */
export function buildCommandContext(d: CommandDeps): CommandContext {
    const { context, chatView, surfaceDeps } = d;

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
            ChatPanel.show(context, surfaceDeps).openTerminalDialogue(backend, opts, title);
        } else {
            void chatView.openTerminalDialogue(backend, opts, title);
        }
    };

    // Registry of tmux-backed persistent terminal sessions (survive VS Code quit).
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

    return { ...d, infoOf, inEditor, startTerminal, persistKey, persistGet, persistAdd, tmuxAlive };
}
