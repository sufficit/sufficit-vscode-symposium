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
    // Keep native navigation disabled; the host opens the destination exactly once.
    // An anchor without href needs an explicit keyboard focus and activation path.
    element.setAttribute("role", "link");
    element.tabIndex = 0;
    element.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
    });
    element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        open();
    });
    element.addEventListener("contextmenu", (event) =>
        showLinkMenu(event as MouseEvent, href, open, kind),
    );
}
