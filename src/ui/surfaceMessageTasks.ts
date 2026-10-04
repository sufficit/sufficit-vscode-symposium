/**
 * Task-list message handlers for the chat surface.
 *
 * Split out of surfaceMessages.ts so that file stays under the 400-line cap.
 * Behavior is identical to the previous inline case body, with one addition:
 * hub permission failures (401/403) surface a reconnect hint instead of
 * looking like a hub outage (see sync/hubErrors.ts).
 */
import * as vscode from "vscode";
import type { WebviewToHost } from "../protocol/chat";
import { HubRequestError } from "../sync/hubErrors";
import { setTaskDone } from "../sync/tasks";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

/** Handles task checkbox state changes coming from the webview. */
export async function handleTaskSetDoneMessage(
    d: SurfaceMessagesDeps,
    message: WebviewToHost,
): Promise<void> {
    if (message.type !== "task-set-done" || !d.hub.configured()) {
        return;
    }
    const id = message.id;
    const done = message.done === true;
    try {
        const ok = await setTaskDone(d.hub, id, done);
        if (ok) {
            d.sync.setTasksDoneByIds([id], done);
        } else {
            void d.sync.refreshTasks();
        }
    } catch (error) {
        // A 401/403 means a stale/insufficient token: tell the user to
        // reconnect instead of looking like a hub bug.
        if (error instanceof HubRequestError && error.permissionProblem) {
            void vscode.window.showWarningMessage(
                "Sufficit account token lacks a permission the hub requires. Sign out and sign back in, then retry.",
            );
        }
        void d.sync.refreshTasks();
    }
}
