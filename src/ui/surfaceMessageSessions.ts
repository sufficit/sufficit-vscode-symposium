/**
 * Session-management message handlers for the chat surface.
 *
 * Split out of surfaceMessages.ts so that file stays under the 400-line cap.
 * Handles session-action (open/rename/watch/archive/pin/delete with lineage
 * cascade), session-list-backends, and session-switch-backend (cross-agent
 * handoff). Behavior is identical to the inline case bodies.
 */
import * as vscode from "vscode";
import type { WebviewToHost } from "./protocol";
import type { SurfaceMessagesDeps } from "./surfaceMessages";

/** Handles session-action / session-list-backends / session-switch-backend. Returns true if handled. */
export async function handleSessionMessage(message: WebviewToHost, d: SurfaceMessagesDeps): Promise<boolean> {
    switch (message?.type) {
        case "session-action": {
            const sessions = await d.deps.listSessions();
            const info = sessions.find((s) => s.sessionId === message.sessionId && s.backend === message.backend);
            if (!info) {
                return true;
            }
            const command = {
                open: "symposium.resumeInTerminal",
                rename: "symposium.renameSession",
                watch: "symposium.followSession",
                archive: "symposium.archiveSession",
                unarchive: "symposium.unarchiveSession",
                pin: "symposium.pinSession",
                unpin: "symposium.unpinSession",
                pinUp: "symposium.pinUp",
                pinDown: "symposium.pinDown",
                delete: "symposium.deleteSession",
            }[message.action as string];
            if (!command) {
                return true;
            }
            // Archive / unarchive / delete cascade across the whole
            // conversation lineage — a conversation (sessions sharing a
            // lineageId) is atomic, so the action hits all of its sessions.
            if (message.action === "archive" || message.action === "unarchive" || message.action === "delete") {
                const lineageKey = info.lineageId || info.sessionId;
                const targets = sessions.filter((s) => (s.lineageId || s.sessionId) === lineageKey);
                if (message.action === "delete" && targets.length > 1) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Permanently delete this conversation and all ${targets.length} of its sessions? Every transcript is scrubbed from disk and it cannot be undone.`,
                        { modal: true },
                        "Delete all",
                    );
                    if (confirm !== "Delete all") {
                        return true;
                    }
                    for (const target of targets) {
                        await vscode.commands.executeCommand("symposium.deleteSession", target, { skipConfirm: true });
                    }
                    return true;
                }
                for (const target of targets) {
                    await vscode.commands.executeCommand(command, target);
                }
                return true;
            }
            await vscode.commands.executeCommand(command, info);
            return true;
        }
        case "session-list-backends": {
            // "Continue with another agent" from a session's right-click
            // menu: offer every configured backend except the session's own.
            const items = [...d.deps.adapterByBackend.values()].map((adapter) => ({
                backend: adapter.backend,
                name: adapter.displayName ?? adapter.backend,
                current: adapter.backend === message.backend,
            }));
            d.post({ type: "session-backends", items });
            return true;
        }
        case "session-switch-backend": {
            if (
                typeof message.sessionId === "string" &&
                typeof message.backend === "string" &&
                typeof message.targetBackend === "string"
            ) {
                await d.handoff.forSession(
                    message.sessionId,
                    message.backend,
                    message.targetBackend,
                );
            }
            return true;
        }
        default:
            return false;
    }
}
