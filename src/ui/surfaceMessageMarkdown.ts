import * as vscode from "vscode";
import { loadMarkdownImage } from "./markdownImages";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

/** Resolves one local Markdown image and returns a CSP-safe data URL. */
export async function handleMarkdownImageMessage(
    message: { id?: unknown; path?: unknown },
    deps: SurfaceMessagesDeps,
): Promise<void> {
    if (typeof message.id !== "string" || !/^md-image-\d+$/.test(message.id)) {
        return;
    }
    if (typeof message.path !== "string" || !message.path.trim()) {
        return;
    }
    const cwd = deps.getController()?.cwd ?? deps.getTerminalSession()?.cwd;
    const roots = [
        cwd,
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    ].filter((root): root is string => Boolean(root));
    const result = await loadMarkdownImage(message.path, cwd, roots);
    deps.post({ type: "markdown-image", id: message.id, ...result });
}
