import type { WebviewToHost } from "../../protocol/chat";
import type { PersistedWebviewState } from "./types";

// acquireVsCodeApi() may only be called once per webview. Keep the raw handle
// private so every outbound message crosses the typed protocol boundary.
const vscode = acquireVsCodeApi();

export function postMessage(message: WebviewToHost): void {
    vscode.postMessage(message);
}

// Persisted webview UI state (send mode, pane width, collapsed groups, …).
const initialState = vscode.getState();
export const saved: PersistedWebviewState =
    initialState && typeof initialState === "object" ? (initialState as PersistedWebviewState) : {};
export function saveState(patch: Partial<PersistedWebviewState>): void {
    if (vscode.setState) {
        vscode.setState(Object.assign({}, saved, patch));
    }
    Object.assign(saved, patch);
}
