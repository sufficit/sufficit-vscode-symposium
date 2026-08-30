/**
 * Session-management message handlers for the chat surface.
 *
 * Split out of surfaceMessages.ts so that file stays under the 400-line cap.
 * Handles session-action (open/rename/watch/archive/pin/delete with lineage
 * cascade), session-list-backends, and session-switch-backend (cross-agent
 * handoff). Behavior is identical to the inline case bodies.
 */
import * as vscode from "vscode";
import type { WebviewToHost } from "../protocol/chat";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

/** Handles session-action / session-list-backends / session-switch-backend. Returns true if handled. */
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
            // really are the one conversation, just not descendants.
            if (
                message.action === "archive" ||
                message.action === "unarchive" ||
                message.action === "delete"
            ) {
                const byParent = new Map<string, typeof sessions>();
                for (const s of sessions) {
                    if (!s.parentId) {
                        continue;
                    }
                    const siblings = byParent.get(s.parentId);
                    if (siblings) {
                        siblings.push(s);
                    } else {
                        byParent.set(s.parentId, [s]);
                    }
                }
                const descendants: typeof sessions = [];
                const walk = (id: string) => {
                    for (const child of byParent.get(id) ?? []) {
                        descendants.push(child);
                        walk(child.sessionId);
                    }
                };
                walk(info.sessionId);
                let targets: typeof sessions;
                if (!info.parentId) {
                    const lineageKey = info.lineageId || info.sessionId;
                    const lineageMates = sessions.filter(
                        (s) => !s.parentId && (s.lineageId || s.sessionId) === lineageKey,
                    );
                    const byId = new Map(
                        [...lineageMates, info, ...descendants].map((s) => [s.sessionId, s]),
                    );
                    targets = [...byId.values()];
                } else {
                    targets = [info, ...descendants];
                }
                if (message.action === "delete" && targets.length > 1) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Permanently delete this conversation and all ${targets.length} of its sessions? Every transcript is scrubbed from disk and it cannot be undone.`,
                        { modal: true },
                        "Delete all",
                    );
                    if (confirm !== "Delete all") {
                        return true;
                    }
                    // silent: true — one refresh + one summary toast for the
                    // whole batch instead of per-session (see deleteSession's
                    // comment: that per-session IPC/notification burst has
                    // been observed to crash the extension host outright on a
                    // parent + several subagent children cascade). The
                    // between-deletes yield gives the event loop a moment to
                    // drain before the next heavy dispose+delete.
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
