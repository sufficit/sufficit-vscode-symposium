import * as vscode from "vscode";
import type { AgentAdapter } from "../adapters/types";
import type { ChatController } from "../application/chatController";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

export async function revertSurfaceAudioHistory(
    deps: SurfaceMessagesDeps,
    controller: ChatController,
    adapter: AgentAdapter,
    sessionId: string,
): Promise<void> {
    if (!adapter.revertBeforeAudioError) return;
    const confirm = "Recover model context";
    const accepted = await vscode.window.showWarningMessage(
        "Remove the failed audio turn and later turns from the Codex model context?",
        {
            modal: true,
            detail: "Your visible conversation, draft and session ID will stay in place. Work already performed will also stay in place.",
        },
        confirm,
    );
    if (accepted !== confirm || deps.getController() !== controller) return;
    if (!controller.beginHistoryRecovery()) {
        throw new Error("The session must be idle with an empty queue and available on this host.");
    }
    try {
        await adapter.revertBeforeAudioError(sessionId, controller.cwd);
        deps.post({
            type: "toast",
            text: "Codex context recovered. You can continue in this session.",
        });
    } finally {
        controller.endHistoryRecovery();
    }
}
