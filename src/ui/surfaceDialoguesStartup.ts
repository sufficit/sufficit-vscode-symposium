import * as vscode from "vscode";
import type { SessionInfo, SessionStartOptions } from "../adapters/types";
import type { SurfaceDialoguesDeps } from "./surfaceDialoguesTypes";

/**
 * Surface startup flows: restoring the last active session on open and picking
 * the backend for a default dialogue. Extracted from SurfaceDialogues as free
 * functions following the collaborator + deps-bag pattern (see
 * surfaceBranching.ts); the surface stays the owner of session state and is
 * reached here via the deps bag plus open callbacks.
 */

type OpenDialogue = (backend: string, options: SessionStartOptions, title: string) => void;

/** Restores the last active session on open, or starts a default dialogue. */
export async function restoreOrStart(
    d: SurfaceDialoguesDeps,
    openSession: (info: SessionInfo) => void,
    startDefaultDialogue: () => void,
): Promise<void> {
    const last = d.deps.lastActive.get();
    if (last) {
        // Time-bound: a backend's listSessions() (e.g. HTTP model discovery)
        // can hang on code-server with no network/auth; never let it block
        // startup and trap the UI on the boot screen.
        const sessions = await Promise.race([
            d.deps.listSessions().catch(() => [] as SessionInfo[]),
            new Promise<SessionInfo[]>((resolve) => setTimeout(() => resolve([]), 6000)),
        ]);
        const info = sessions.find(
            (s) => s.sessionId === last.sessionId && s.backend === last.backend,
        );
        if (info) {
            openSession(info);
            return;
        }
    }
    startDefaultDialogue();
}

/** Starts a new dialogue with Sufficit AI by default, then falls back to any available backend. */
export function startDefaultDialogue(d: SurfaceDialoguesDeps, openDialogue: OpenDialogue): void {
    const backend = d.deps.adapterByBackend.has("openai")
        ? "openai"
        : d.deps.adapterByBackend.keys().next().value;
    if (!backend) {
        void d.webview.postMessage({
            type: "boot",
            id: "session",
            label: "No backend available",
            status: "fail",
            detail: "configure an adapter",
        });
        void d.webview.postMessage({ type: "boot", complete: true });
        return;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    openDialogue(backend, { cwd }, "New dialogue");
}
