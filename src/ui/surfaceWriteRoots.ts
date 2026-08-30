import * as vscode from "vscode";
import type { SessionStartOptions } from "../adapters/types";

/** Adds the host-owned workspace write boundary to a session when absent. */
export function ensureAllowedWriteRoots(
    options: SessionStartOptions,
    post: (message: unknown) => void,
): SessionStartOptions {
    if (options.allowedWriteRoots?.length) return options;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length) {
        return { ...options, allowedWriteRoots: folders.map((folder) => folder.uri.fsPath) };
    }
    post({
        type: "event",
        event: {
            kind: "status-notice",
            text: "No workspace folder open — write-root containment is OFF. The agent can write to any path.",
        },
    });
    return options;
}
