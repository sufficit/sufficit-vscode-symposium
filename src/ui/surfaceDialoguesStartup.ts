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

/**
 * Restores the last active session from the live runtime / cached SessionIndex
 * snapshot via deps.getSession — never through listSessions(), which scans
 * every backend (its former 6s Promise.race abandoned the scan it started;
 * the scan kept reading multi-GB corpora in the background). A cold index that
 * has not indexed the session yet falls back to the default dialogue; the
 * background index reconcile repopulates the snapshot without blocking here.
 */
export function restoreOrStart(
    d: SurfaceDialoguesDeps,
    openSession: (info: SessionInfo) => void,
    startDefaultDialogue: () => void,
): void {
    const last = d.deps.lastActive.get();
    const info = last ? d.deps.getSession?.(last.backend, last.sessionId) : undefined;
    if (info) {
        openSession(info);
        return;
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
