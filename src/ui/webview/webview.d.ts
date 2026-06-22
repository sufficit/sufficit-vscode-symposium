// Ambient globals available inside the VS Code webview runtime (not Node).
export {};

declare global {
    /** Acquire the webview ↔ extension messaging bridge (callable once). */
    function acquireVsCodeApi(): {
        postMessage(message: unknown): void;
        getState(): unknown;
        setState(state: unknown): void;
    };
}
