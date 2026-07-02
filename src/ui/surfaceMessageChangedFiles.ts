/**
 * Changed-files panel message handlers for the chat surface.
 *
 * Split out of surfaceMessages.ts so that file stays under the 400-line cap.
 * Handles file-approve / file-reject / file-approve-all / file-reject-all —
 * accepting or reverting the agent's file edits via the ChangedFilesManager.
 * Behavior is identical to the inline case bodies.
 */
import * as vscode from "vscode";
import type { WebviewToHost } from "./protocol";
import type { SurfaceMessagesDeps } from "./surfaceMessages";

/** Handles file-approve/reject/approve-all/reject-all. Returns true if handled. */
export async function handleChangedFilesMessage(message: WebviewToHost, d: SurfaceMessagesDeps): Promise<boolean> {
    switch (message?.type) {
        case "file-approve": {
            if (typeof message.path === "string") {
                await d.changedFiles.approve(message.path);
                d.changedFiles.refreshNow();
            }
            return true;
        }
        case "file-reject": {
            if (typeof message.path === "string") {
                if (await d.changedFiles.reject(message.path)) { d.getController()?.resolveChanged(message.path); }
                else { void vscode.window.showWarningMessage("Could not revert " + message.path); }
                d.changedFiles.refreshNow();
            }
            return true;
        }
        case "file-approve-all": {
            // Operate on exactly the paths the panel shows (sent by the
            // webview); fall back to the controller's tracked set.
            const paths = message.paths ?? d.getController()?.changedPaths() ?? [];
            for (const p of paths) {
                await d.changedFiles.approve(p);
            }
            d.changedFiles.refreshNow();
            return true;
        }
        case "file-reject-all": {
            const paths = message.paths ?? d.getController()?.changedPaths() ?? [];
            if (!paths.length) { return true; }
            const pick = await vscode.window.showWarningMessage(
                `Revert ${paths.length} file(s) to their pre-edit state? This discards the agent's changes.`,
                { modal: true }, "Revert");
            if (pick !== "Revert") { return true; }
            for (const p of paths) {
                if (await d.changedFiles.reject(p)) { d.getController()?.resolveChanged(p); }
            }
            d.changedFiles.refreshNow();
            return true;
        }
        default:
            return false;
    }
}
