import * as vscode from "vscode";
import { SessionInfo } from "../../adapters/types";
import { ChatPanel } from "../../ui/chatPanel";
import { snapshots } from "../../snapshots";
import { expireSessionTasks } from "../../sync/tasks";
import { HubClient } from "../../sync/hubClient";
import { symposiumLog } from "../log";
import { errorDetails, showErrorWithCopy } from "../errors";
import { CommandContext } from "./helpers";

/** Open / follow / rename / archive / pin / delete session commands. */
export function registerSessionCommands(ctx: CommandContext): void {
    const { context, adapterByBackend, surfaceDeps, chatView, runtime, sessionIndex, store, deleting, refreshAll, inEditor, infoOf } = ctx;

    context.subscriptions.push(
        // Editor-title session history action. QuickPick gives the requested
        // modal popup without switching the current Symposium tab first.
        vscode.commands.registerCommand("symposium.pickEditorSession", async () => {
            const sessions = (await surfaceDeps.listSessions())
                .filter((session) => !session.archived && !session.deleting)
                .sort((a, b) => {
                    if (!!a.pinned !== !!b.pinned) { return a.pinned ? -1 : 1; }
                    return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
                });
            if (!sessions.length) {
                void vscode.window.showInformationMessage("No Symposium sessions found.");
                return;
            }
            const choice = await vscode.window.showQuickPick(sessions.map((info) => ({
                label: `${info.pinned ? "$(pin) " : ""}${info.title || "Untitled session"}`,
                description: info.backendName ?? info.backend,
                detail: [
                    info.updatedAt ? info.updatedAt.toLocaleString() : "",
                    info.cwd ?? "",
                    info.status === "working" ? "working" : "",
                ].filter(Boolean).join("  •  "),
                info,
            })), {
                placeHolder: "Open a Symposium session",
                matchOnDescription: true,
                matchOnDetail: true,
            });
            if (choice) { ChatPanel.openSession(context, surfaceDeps, choice.info); }
        }),

        vscode.commands.registerCommand("symposium.openSession", (info: SessionInfo) => {
            if (inEditor()) {
                ChatPanel.openSession(context, surfaceDeps, info);
            } else {
                void chatView.openSession(info);
            }
        }),

        vscode.commands.registerCommand("symposium.openSessionInEditor", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = "info" in item && item.info ? item.info : item as SessionInfo;
            ChatPanel.openSession(context, surfaceDeps, info);
        }),

        vscode.commands.registerCommand("symposium.followSession", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = "info" in item && item.info ? item.info : item as SessionInfo;
            if (inEditor()) {
                ChatPanel.followSession(context, surfaceDeps, info);
            } else {
                void chatView.followSession(info);
            }
        }),

        vscode.commands.registerCommand("symposium.renameSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            const info = infoOf(item);
            const value = await vscode.window.showInputBox({
                prompt: "Rename session",
                value: info.title,
                valueSelection: [0, info.title.length],
            });
            if (value === undefined) {
                return; // cancelled
            }
            await store.setTitle(info, value);
            refreshAll();
        }),

        vscode.commands.registerCommand("symposium.archiveSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.setArchived(infoOf(item), true);
            refreshAll();
        }),

        vscode.commands.registerCommand("symposium.unarchiveSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.setArchived(infoOf(item), false);
            refreshAll();
        }),

        vscode.commands.registerCommand("symposium.pinSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.setPinned(infoOf(item), true);
            refreshAll();
        }),
        vscode.commands.registerCommand("symposium.unpinSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.setPinned(infoOf(item), false);
            refreshAll();
        }),
        vscode.commands.registerCommand("symposium.pinUp", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.movePinned(infoOf(item), -1);
            refreshAll();
        }),
        vscode.commands.registerCommand("symposium.pinDown", async (item: { info?: SessionInfo } | SessionInfo) => {
            await store.movePinned(infoOf(item), 1);
            refreshAll();
        }),
        vscode.commands.registerCommand("symposium.reorderPinned", async (ids: string[]) => {
            await store.setPinnedOrder(Array.isArray(ids) ? ids : []);
            refreshAll();
        }),

        // `silent` (used by the multi-session cascade delete in
        // surfaceMessageSessions.ts): suppresses the per-session refreshAll()/
        // toast — a 4+ session cascade otherwise fires ~3 renderer refreshes
        // and a native OS notification PER session, back-to-back with no
        // yield between them. That burst of extension-host <-> renderer IPC
        // has been observed to crash the extension host outright (SIGILL deep
        // inside VS Code's own Electron/V8 binary, not Symposium's JS) when
        // deleting a parent session with several subagent children. The
        // caller does ONE refresh + ONE summary toast after the whole batch
        // instead. Returns { ok, residual? } so the caller can aggregate.
        vscode.commands.registerCommand("symposium.deleteSession", async (
            item: { info?: SessionInfo } | SessionInfo,
            opts?: { skipConfirm?: boolean; silent?: boolean },
        ): Promise<{ ok: boolean; title: string; residual?: string[] } | undefined> => {
            const info = infoOf(item);
            const silent = !!opts?.silent;
            const adapter = adapterByBackend.get(info.backend);
            if (!adapter?.deleteSession) {
                if (silent) { return { ok: false, title: info.title }; }
                const details = JSON.stringify({ action: "deleteSession", backend: info.backend, sessionId: info.sessionId, title: info.title }, null, 2);
                const pick = await vscode.window.showWarningMessage(`Deleting ${info.backend} sessions is not supported.`, "Copy details");
                if (pick === "Copy details") { await vscode.env.clipboard.writeText(details); }
                return { ok: false, title: info.title };
            }
            // Flag it as deleting BEFORE the confirm modal so the list shows the
            // marker immediately — the modal itself can lag, and the user needs
            // instant feedback that the click registered. Reverted if cancelled.
            deleting.add(info.sessionId);
            if (!silent) { refreshAll(); }
            if (!opts?.skipConfirm) {
                const confirm = await vscode.window.showWarningMessage(
                    `Permanently delete "${info.title}"?\n\nThis scrubs the transcript and all history/index entries for this session (${info.sessionId}) from the ${info.backend} CLI on disk. It cannot be undone.`,
                    { modal: true },
                    "Delete permanently",
                );
                if (confirm !== "Delete permanently") {
                    deleting.delete(info.sessionId);
                    if (!silent) { refreshAll(); }
                    return { ok: false, title: info.title };
                }
            }
            // Close the conversation pane now if it's showing this session.
            // Do this before disposing the controller: a brand-new session has
            // no resume id, so dispose() would erase the only in-memory id the
            // surface can use to recognize the active pane.
            chatView.sessionDeleted(info.sessionId);
            ChatPanel.sessionDeleted(info.sessionId);
            runtime.disposeBySessionId(info.sessionId); // stop it if running
            if (!silent) { refreshAll(); }
            try {
                snapshots.clearSession(info.sessionId);      // drop in-memory baselines
                const residual = await adapter.deleteSession(info);
                // The adapter removed the canonical transcript. Evict the stale
                // catalog row before dropping its custom title; otherwise the
                // cached row flashes back with a generic title until reconcile,
                // making the user delete the same Claude session twice.
                sessionIndex.forget(info.backend, info.sessionId);
                await store.forget(info);
                // Remove the session's tasks from Sufficit memory (soft-delete via
                // expiry) — tasks are bound to the session id.
                let expired = 0;
                try { expired = await expireSessionTasks(new HubClient(), info.sessionId); } catch { /* best-effort */ }
                if (expired) { symposiumLog(`[delete] expired ${expired} memory task(s) for ${info.sessionId}`); }
                const residualList = Array.isArray(residual) && residual.length ? residual : undefined;
                if (!silent) {
                    if (residualList) {
                        void vscode.window.showWarningMessage(
                            `Session deleted. Residual data may remain in: ${residualList.join(", ")} — clear it manually if required.`);
                    } else {
                        void vscode.window.showInformationMessage(`Session "${info.title}" permanently deleted.`);
                    }
                }
                return { ok: true, title: info.title, residual: residualList };
            } catch (error) {
                if (!silent) {
                    void showErrorWithCopy(
                        `Delete failed: ${error instanceof Error ? error.message : error}`,
                        JSON.stringify({ action: "deleteSession", backend: info.backend, sessionId: info.sessionId, title: info.title, error: errorDetails(error) }, null, 2),
                    );
                }
                return { ok: false, title: info.title };
            } finally {
                // Whether scrub succeeded or failed, stop flagging it; a failed
                // delete reappears (now off disk-or-not per adapter) so the user
                // can retry, a successful one is already gone from disk.
                deleting.delete(info.sessionId);
                if (!silent) { refreshAll(); }
            }
        }),
    );
}
