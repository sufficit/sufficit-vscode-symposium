import * as path from "path";
import * as vscode from "vscode";
import { AgentAdapter, SessionInfo } from "../adapters/types";
import { SessionStore } from "../sessions/store";
import { LiveSessions } from "../sessions/runtime";
import { ChatSurfaceDeps } from "../ui/chatSurface";
import { SufficitAuth } from "../auth/identity";

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
}
