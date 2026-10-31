/**
 * Session-management message handlers for the chat surface.
 *
 * Split out of surfaceMessages.ts so that file stays under the 400-line cap.
 * Handles session-action (open/rename/watch/archive/pin/delete with lineage
 * cascade), sessions-bulk (multi-select / project-wide archive + delete),
 * session-list-backends, and session-switch-backend (cross-agent handoff).
 * Behavior is identical to the inline case bodies.
 */
import * as vscode from "vscode";
import type { SessionInfo } from "../adapters/types";
import type { WebviewToHost } from "../protocol/chat";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";
import { expandBulkCascadeTargets, expandSessionCascadeTargets } from "./surfaceSessionCascade";

/**
 * Deletes a batch of sessions with ONE confirm (shown by the caller) and ONE
 * refresh + summary toast, via the silent per-session delete command. The
 * between-deletes yield gives the event loop a moment to drain before the
 * next heavy dispose+delete: the per-session IPC/notification burst has been
 * observed to crash the extension host outright on a parent + several
 * subagent children cascade (see deleteSession's comment in commands).
 */
async function deleteTargetsSilently(targets: SessionInfo[]): Promise<boolean> {
    const results: { ok: boolean; title: string; residual?: string[] }[] = [];
    for (const target of targets) {
        const r = await vscode.commands.executeCommand<{
            ok: boolean;
            title: string;
            residual?: string[];
        }>("symposium.deleteSession", target, { skipConfirm: true, silent: true });
        if (r) {
            results.push(r);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await vscode.commands.executeCommand("symposium.refreshSessions");
    const failed = results.filter((r) => !r.ok);
    const withResidual = results.filter((r) => r.residual?.length);
    if (failed.length) {
        void vscode.window.showWarningMessage(
            `Deleted ${results.length - failed.length}/${targets.length} sessions; ${failed.length} failed: ${failed.map((r) => r.title).join(", ")}.`,
        );
    } else if (withResidual.length) {
        void vscode.window.showWarningMessage(
            `Deleted all ${targets.length} sessions. Residual data may remain for: ${withResidual.map((r) => r.title).join(", ")} — clear manually if required.`,
        );
    } else {
        void vscode.window.showInformationMessage(
            `Deleted all ${targets.length} sessions permanently.`,
        );
    }
    return true;
}

/** Handles session-action / sessions-bulk / session-list-backends / session-switch-backend. Returns true if handled. */
export async function handleSessionMessage(
    message: WebviewToHost,
    d: SurfaceMessagesDeps,
): Promise<boolean> {
    switch (message?.type) {
        case "session-action": {
            const sessions = await d.deps.listSessions();
            const info = sessions.find(
                (s) => s.sessionId === message.sessionId && s.backend === message.backend,
            );
            if (!info) {
                return true;
            }
            const command = {
                open: "symposium.resumeInTerminal",
                openEditor: "symposium.openSessionInEditor",
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
            // Archive / unarchive / delete cascade DOWN the subagent tree
            // (parentId) — a session's own action must never reach back up to
            // its parent or sideways to siblings, only itself + whatever it
            // spawned. A ROOT session (no parentId) additionally drags its
            // lineage-mates (edit/resend branches of the SAME conversation,
            // SessionInfo.lineageId — a different relationship: same logical
            // thread under another id, not a parent/child tree) since those
            // really are the one conversation, just not descendants. The
            // expansion lives in surfaceSessionCascade.ts and is shared with
            // the sessions-bulk path so the two can never drift.
            if (
                message.action === "archive" ||
                message.action === "unarchive" ||
                message.action === "delete"
            ) {
                const targets = expandSessionCascadeTargets(info, sessions);
                if (message.action === "delete" && targets.length > 1) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Permanently delete this conversation and all ${targets.length} of its sessions? Every transcript is scrubbed from disk and it cannot be undone.`,
                        { modal: true },
                        "Delete all",
                    );
                    if (confirm !== "Delete all") {
                        return true;
                    }
                    return deleteTargetsSilently(targets);
                }
                for (const target of targets) {
                    await vscode.commands.executeCommand(command, target);
                }
                return true;
            }
            await vscode.commands.executeCommand(command, info);
            return true;
        }
        case "sessions-bulk": {
            // Multi-select bar / project-group menu: one message, one confirm,
            // one silent batch. Cascades are expanded host-side so selecting a
            // parent chat also covers its subagents and edit branches.
            if (!Array.isArray(message.items) || !message.items.length) {
                return true;
            }
            const sessions = await d.deps.listSessions();
            const targets = expandBulkCascadeTargets(message.items, sessions);
            if (!targets.length) {
                return true;
            }
            if (message.action === "delete") {
                const confirm = await vscode.window.showWarningMessage(
                    `Permanently delete ${message.items.length} chat(s) — ${targets.length} session(s) once subagents and edit branches are included? Every transcript is scrubbed from disk and it cannot be undone.`,
                    { modal: true },
                    "Delete all",
                );
                if (confirm !== "Delete all") {
                    return true;
                }
                return deleteTargetsSilently(targets);
            }
            const command =
                message.action === "archive"
                    ? "symposium.archiveSession"
                    : "symposium.unarchiveSession";
            for (const target of targets) {
                await vscode.commands.executeCommand(command, target);
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            void vscode.window.showInformationMessage(
                `${message.action === "archive" ? "Archived" : "Unarchived"} ${targets.length} session(s).`,
            );
            return true;
        }
        case "session-list-backends": {
            // "Continue with another agent" from a session's right-click
            // menu: offer every configured backend except the session's own.
            const items = [...d.deps.adapterByBackend.values()]
                .filter((adapter) => adapter.canStartSessions !== false)
                .map((adapter) => ({
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
