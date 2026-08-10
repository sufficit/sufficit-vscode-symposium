import * as path from "path";
import * as vscode from "vscode";
import { AgentAdapter, SessionInfo } from "../adapters/types";
import { SessionStore } from "../sessions/store";
import { LiveSessions } from "../sessions/runtime";
import { ChatSurfaceDeps } from "../ui/chatSurface";
import { SufficitAuth } from "../auth/identity";
import { configuredModel, setConfiguredModel } from "./config";
import type { AhpHostRuntime } from "../ahp/hostRuntime";
import type { SymposiumApi } from "../api/symposiumApi";

export interface SurfaceDepsArgs {
    context: vscode.ExtensionContext;
    runtime: LiveSessions;
    store: SessionStore;
    adapterByBackend: Map<string, AgentAdapter>;
    auth: SufficitAuth;
    /** Session ids currently being deleted (flagged in the list, excluded once gone). */
    deleting: Set<string>;
    /** All persisted sessions across adapters, newest first. */
    rawSessions: () => Promise<SessionInfo[]>;
    api: SymposiumApi;
    ahpRuntime: () => AhpHostRuntime | undefined;
    syncAhp: () => void;
    rebuildAhp: (provider: string, sessionId: string) => void;
}

/** Assembles the ChatSurface dependency bundle shared by the sidebar + panel hosts. */
export function buildChatSurfaceDeps(args: SurfaceDepsArgs): ChatSurfaceDeps {
    const { context, runtime, store, adapterByBackend, auth, deleting, rawSessions } = args;
    return {
        adapterByBackend,
        // Return ALL sessions (archived flag + live runtime status); the webview
        // list shows/hides archived itself and renders the working indicator.
        // Live sessions not yet written to disk are merged in (top) so a brand-
        // new running session shows its working indicator immediately.
        listSessions: async () => {
            const liveInfos = runtime.liveInfos();
            // Persist the subagent→parent link while it's live, so the session
            // stays nested under its main conversation after it's stored to disk
            // (disk rows otherwise lose the in-memory parentId).
            for (const l of liveInfos) {
                if (l.parentId) {
                    store.setParent(l.sessionId, l.parentId);
                }
                if (l.lineageId) {
                    store.setLineage(l.sessionId, l.lineageId);
                }
            }
            const disk = store.decorate(await rawSessions(), true).map((s) => {
                const status = runtime.statusFor(s.sessionId) ?? s.terminalStatus;
                const adapter = adapterByBackend.get(s.backend);
                return { ...s, backendName: adapter?.displayName ?? s.backend, status };
            });
            const known = new Set(disk.map((s) => s.sessionId));
            const live = liveInfos
                .filter((l) => !known.has(l.sessionId) && !l.sessionId.startsWith("new-"))
                .map(
                    (l) =>
                        ({
                            ...l,
                            backendName: adapterByBackend.get(l.backend)?.displayName ?? l.backend,
                            updatedAt: new Date(),
                        }) as SessionInfo,
                );
            return [...live, ...disk].map((s) =>
                deleting.has(s.sessionId) ? { ...s, deleting: true } : s,
            );
        },
        // Resume must run in the session's original cwd: the CLIs scope sessions per directory.
        cwdFor: (info) =>
            info.cwd && path.isAbsolute(info.cwd)
                ? info.cwd
                : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()),
        runtime,
        ahp: {
            api: args.api,
            runtime: args.ahpRuntime,
            sync: args.syncAhp,
            rebuild: args.rebuildAhp,
        },
        lastActive: {
            // Per-workspace: reopening the window restores the session you were on.
            get: () => context.workspaceState.get("symposium.lastActive"),
            set: (value) => void context.workspaceState.update("symposium.lastActive", value),
        },
        account: {
            get: (force?: boolean) => auth.getProfile(force),
            onDidChange: auth.onDidChange,
        },
        modelPrefs: {
            getPinned: (backend: string) =>
                context.workspaceState.get<string[]>(`symposium.pinnedModels.${backend}`, []),
            setPinned: (backend: string, models: string[]) =>
                void context.workspaceState.update(`symposium.pinnedModels.${backend}`, models),
            getDefault: (backend: string) => configuredModel(backend),
            setDefault: (backend: string, model: string | undefined) => {
                // Prefer workspace-scoped settings so different projects can use different
                // default models. Fall back to global when no workspace folder is open
                // (otherwise VS Code throws "Unable to write into workspace settings").
                const target = vscode.workspace.workspaceFolders?.length
                    ? vscode.ConfigurationTarget.Workspace
                    : vscode.ConfigurationTarget.Global;
                return setConfiguredModel(backend, model, target);
            },
        },
        store: {
            setParent: (sessionId: string, parentId: string | undefined) =>
                store.setParent(sessionId, parentId),
            setLineage: (sessionId: string, lineageId: string | undefined) =>
                store.setLineage(sessionId, lineageId),
        },
    };
}
