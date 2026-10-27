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
 * Resolves the last active session from live/registered metadata without an
 * all-backend listSessions() scan. The cached SessionIndex snapshot is the
 * fast path; when the index does not know the session yet, a single bounded
 * adapter lookup may recover it (direct path), and only when that also fails
 * does the caller fall back to a fresh default dialogue.
 */
async function resolveLastSession(
    d: SurfaceDialoguesDeps,
    last: { backend: string; sessionId: string },
): Promise<SessionInfo | undefined> {
    const fromIndex = d.deps.getSession?.(last.backend, last.sessionId);
    if (fromIndex) {
        return fromIndex;
    }
    const adapter = d.deps.adapterByBackend.get(last.backend);
    if (!adapter?.getSession) {
        return undefined;
    }
    try {
        return await adapter.getSession(last.sessionId);
    } catch {
        // A backend-specific direct lookup failing (missing transcript, CLI
        // hiccup) is not fatal: the default dialogue fallback still applies.
        return undefined;
    }
}

/** Restores the last active session on open, or starts a default dialogue. */
export async function restoreOrStart(
    d: SurfaceDialoguesDeps,
    openSession: (info: SessionInfo) => void,
    startDefaultDialogue: () => void,
): Promise<void> {
    const last = d.deps.lastActive.get();
    if (last) {
        const info = await resolveLastSession(d, last);
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
