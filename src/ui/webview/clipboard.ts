import { postMessage } from "./vscode";

let sequence = 0;
const pending = new Map<string, { done?: () => void; timer: ReturnType<typeof setTimeout> }>();

function failed(): void {
    // Use the existing inbound toast path without a circular menus dependency.
    window.dispatchEvent(
        new MessageEvent("message", {
            data: {
                type: "toast",
                kind: "error",
                text: "Could not copy text. Please try again.",
            },
        }),
    );
}

export function completeClipboardCopy(id: string, ok: boolean): void {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (ok) request.done?.();
    else failed();
}

/** Browser clipboard first; VS Code's bridge handles denied iframe permissions.
 * Never select a temporary textarea: doing so destroys the user's selection. */
export function copyText(text: string, done?: () => void): void {
    const fallback = () => {
        if (window.__SYMPOSIUM__) {
            failed();
            return;
        }
        const id = `clipboard-${++sequence}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            failed();
        }, 5000);
        pending.set(id, { done, timer });
        postMessage({ type: "copy-text", id, text });
    };
    try {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(() => done?.(), fallback);
            return;
        }
    } catch {
        // Restricted webviews can throw synchronously as well as reject.
    }
    fallback();
}
