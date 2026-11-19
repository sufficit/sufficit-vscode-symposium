import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentAdapter, SessionInfo } from "../adapters/types";
import type { ChatController } from "../application/chatController";
import { codexRecoveredHistoryMarker, ledgerDir } from "../ledger";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

export async function revertSurfaceAudioHistory(
    deps: SurfaceMessagesDeps,
    controller: ChatController,
    adapter: AgentAdapter,
    sessionId: string,
): Promise<void> {
    if (!adapter.revertBeforeAudioError) return;
    const confirm = "Remove turns and continue";
    const accepted = await vscode.window.showWarningMessage(
        "Remove the failed audio turn and all later turns from this session?",
        {
            modal: true,
            detail: "This keeps the same session ID. File edits and other actions already performed will stay in place.",
        },
        confirm,
    );
    if (accepted !== confirm || deps.getController() !== controller) return;
    if (!controller.beginHistoryRecovery()) {
        throw new Error("The session must be idle with an empty queue and available on this host.");
    }
    let current: SessionInfo | undefined;
    const permission = controller.getPermission();
    try {
        current = await adapter.revertBeforeAudioError(sessionId, controller.cwd, (info) => {
            archiveRenderForRecovery(sessionId);
            current = info;
        });
        deps.post({
            type: "toast",
            text: "History recovered. Continue in the same session with a transcript.",
        });
    } finally {
        if (current) {
            // A transport error after the cutoff was sent can leave the native
            // change committed. Rehydrate from Codex instead of replaying the
            // old visual log in either case.
            const visible = deps.getController() === controller;
            deps.deps.runtime.disposeBySessionId(sessionId);
            if (visible) {
                deps.openSession({
                    ...current,
                    title: controller.title,
                    lineageId: controller.lineageId,
                });
                if (permission) deps.getController()?.setPermission(permission);
            }
        } else {
            controller.endHistoryRecovery();
        }
    }
}

/** Saves the old visual log before reconstructing the session from native history. */
function archiveRenderForRecovery(sessionId: string): void {
    const directory = ledgerDir(sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(codexRecoveredHistoryMarker(sessionId), "", { mode: 0o600 });
    const file = path.join(directory, "render.jsonl");
    try {
        renameSync(file, `${file}.before-recovery-${randomUUID()}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}
