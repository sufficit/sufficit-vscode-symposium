import * as vscode from "vscode";

/** Webview resource URIs for the compiled chat client bundle and stylesheet. */
export function buildWebviewAssets(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
): import("./chatHtml").ChatWebviewAssets {
    const scriptAsset = vscode.Uri.joinPath(extensionUri, "out/ui/webview.bundle.js");
    const styleAsset = vscode.Uri.joinPath(extensionUri, "out/ui/webview.css");
    return {
        scriptUri: webview.asWebviewUri(scriptAsset).toString(),
        styleUri: webview.asWebviewUri(styleAsset).toString(),
        cspSource: webview.cspSource,
    };
}
