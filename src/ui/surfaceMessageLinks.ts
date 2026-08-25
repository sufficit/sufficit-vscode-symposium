import * as vscode from "vscode";

const ALLOWED_EXTERNAL_LINK = /^(?:https?|mailto|vscode):/i;

/** Opens only renderer-approved external destinations outside the chat webview. */
export async function openExternalSurfaceLink(value: unknown): Promise<void> {
    if (typeof value !== "string") return;
    const url = value.trim();
    if (!ALLOWED_EXTERNAL_LINK.test(url)) return;
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
}
