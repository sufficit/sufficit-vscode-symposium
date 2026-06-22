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
    const { context, adapterByBackend, surfaceDeps, chatView, runtime, store, deleting, refreshAll, inEditor, infoOf } = ctx;

    context.subscriptions.push(
        vscode.commands.registerCommand("symposium.openSession", (info: SessionInfo) => {
            if (inEditor()) {
                ChatPanel.show(context, surfaceDeps).openSession(info);
            } else {
                void chatView.openSession(info);
            }
        }),

        vscode.commands.registerCommand("symposium.openSessionInEditor", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = "info" in item && item.info ? item.info : item as SessionInfo;
            ChatPanel.show(context, surfaceDeps).openSession(info);
        }),

        vscode.commands.registerCommand("symposium.followSession", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = "info" in item && item.info ? item.info : item as SessionInfo;
            if (inEditor()) {
                void ChatPanel.show(context, surfaceDeps).followSession(info);
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

        vscode.commands.registerCommand("symposium.deleteSession", async (item: { info?: SessionInfo } | SessionInfo) => {
            const info = infoOf(item);
            const adapter = adapterByBackend.get(info.backend);
            if (!adapter?.deleteSession) {
                const details = JSON.stringify({ action: "deleteSession", backend: info.backend, sessionId: info.sessionId, title: info.title }, null, 2);
                const pick = await vscode.window.showWarningMessage(`Deleting ${info.backend} sessions is not supported.`, "Copy details");
                if (pick === "Copy details") { await vscode.env.clipboard.writeText(details); }
                return;
            }
            // Flag it as deleting BEFORE the confirm modal so the list shows the
            // marker immediately — the modal itself can lag, and the user needs
            // instant feedback that the click registered. Reverted if cancelled.
            deleting.add(info.sessionId);
            refreshAll();
            const confirm = await vscode.window.showWarningMessage(
                `Permanently delete "${info.title}"?\n\nThis scrubs the transcript and all history/index entries for this session (${info.sessionId}) from the ${info.backend} CLI on disk. It cannot be undone.`,
                { modal: true },
                "Delete permanently",
            );
            if (confirm !== "Delete permanently") {
                deleting.delete(info.sessionId);
                refreshAll();
                return;
            }
            runtime.disposeBySessionId(info.sessionId); // stop it if running
            // Close the conversation pane now if it's showing this session.
            chatView.sessionDeleted(info.sessionId);
            ChatPanel.sessionDeleted(info.sessionId);
            refreshAll();
            try {
                snapshots.clearSession(info.sessionId);      // drop in-memory baselines
                const residual = await adapter.deleteSession(info);
                await store.forget(info);
                // Remove the session's tasks from Sufficit memory (soft-delete via
                // expiry) — tasks are bound to the session id.
                let expired = 0;
                try { expired = await expireSessionTasks(new HubClient(), info.sessionId); } catch { /* best-effort */ }
                if (expired) { symposiumLog(`[delete] expired ${expired} memory task(s) for ${info.sessionId}`); }
                if (Array.isArray(residual) && residual.length) {
                    void vscode.window.showWarningMessage(
                        `Session deleted. Residual data may remain in: ${residual.join(", ")} — clear it manually if required.`);
                } else {
                    void vscode.window.showInformationMessage(`Session "${info.title}" permanently deleted.`);
                }
            } catch (error) {
                void showErrorWithCopy(
                    `Delete failed: ${error instanceof Error ? error.message : error}`,
                    JSON.stringify({ action: "deleteSession", backend: info.backend, sessionId: info.sessionId, title: info.title, error: errorDetails(error) }, null, 2),
                );
            } finally {
                // Whether scrub succeeded or failed, stop flagging it; a failed
                // delete reappears (now off disk-or-not per adapter) so the user
                // can retry, a successful one is already gone from disk.
                deleting.delete(info.sessionId);
                refreshAll();
            }
        }),
    );
}
