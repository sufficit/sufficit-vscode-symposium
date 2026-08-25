import { showLinkMenu } from "./menus";
import { postMessage } from "./vscode";

type MarkdownTargetKind = "file" | "link";

/** Keeps Markdown navigation outside the chat webview, including context-menu opens. */
export function bindMarkdownTarget(
    element: HTMLElement,
    href: string,
    kind: MarkdownTargetKind,
): void {
    const open = (): void => {
        if (kind === "file") postMessage({ type: "open-file", path: href });
        else postMessage({ type: "open-link", url: href });
    };
    element.addEventListener("click", (event) => {
        event.preventDefault();
        open();
    });
    element.addEventListener("contextmenu", (event) =>
        showLinkMenu(event as MouseEvent, href, open, kind),
    );
}
