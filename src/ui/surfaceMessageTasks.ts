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
    const sessionId = d.getController()?.sessionId;
    if (!sessionId) return;
    try {
        const ok = await setTaskDone(d.hub, sessionId, id, done);
        if (ok && d.getController()?.sessionId === sessionId) {
            d.sync.setTasksDoneByIds([id], done);
        } else {
            void d.sync.refreshTasks();
        }
    } catch (error) {
        if (error instanceof HubRequestError && error.accessNotice) {
            void vscode.window.showWarningMessage(`${error.message}. ${error.accessNotice}`);
        }
        void d.sync.refreshTasks();
    }
}
