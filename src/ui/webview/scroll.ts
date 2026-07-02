// Layout + scroll helpers for the chat log and sessions pane. Side effects
// (ResizeObserver, scroll/listToggle listeners, initial layout) run on import.
import { root, log, logScroller, listToggle } from "./dom";
import { sideMode } from "./state";

// The sessions pane sits on the OUTER edge: docked right → sessions right;
// docked left → sessions left. With no dock-side API, infer from screen position.
export function sideIsRight(): boolean {
    if (sideMode === "left") { return false; }
    if (sideMode === "right") { return true; }
    try {
        const center = ((window as any).screenX || 0) + window.innerWidth / 2;
        return center > (window.screen.width / 2);
    } catch (e) {
        return false;
    }
}

// Responsive: wide surface shows the sessions pane beside the chat; narrow hides
// it behind the toggle (mirrors the built-in chat sessions viewer).
const NARROW = 640;
export function layout(): void {
    root.classList.toggle("narrow", document.body.clientWidth < NARROW);
    root.classList.toggle("side-right", sideIsRight());
}
new ResizeObserver(layout).observe(document.body);
layout();
listToggle.addEventListener("click", () => root.classList.toggle("listOpen"));

// The scroller (#log) is flex column-reverse: the browser anchors the viewport
// to the NEWEST message natively. scrollTop is 0 at the bottom and grows
// NEGATIVE while scrolling up, so restored history extends the scrollbar
// upward without ever moving the view off the last message — no re-snap
// hacks needed when fonts/images/history change the height after first paint.
export function nearBottom(): boolean { return Math.abs(logScroller.scrollTop) < 80; }

// Timestamp of the last PROGRAMMATIC scroll (not user-initiated).
let lastAutoScroll = 0;

// ResizeObserver preserves scroll position when content streams in while
// scrolled up (Chromium does not scroll-anchor reversed flows).
let lastScrollTop = 0;
new ResizeObserver(() => {
    if (!nearBottom()) {
        logScroller.scrollTop = lastScrollTop;
    }
}).observe(log);

// Save scroll position before content changes
function saveScrollPosition(): void {
    lastScrollTop = logScroller.scrollTop;
}

// Auto-scroll the chat log to the bottom, but only if it's near the bottom
// already (so we don't yank away the user while they're reading scrollback).
export function snapToBottom(): void {
    if (nearBottom()) {
        lastAutoScroll = Date.now();
        logScroller.scrollTop = 0; // 0 is the bottom in column-reverse
    }
}

// Called by the stream renderer to auto-scroll the log while new content
// streams in.
export function autoScroll(): void {
    if (nearBottom()) {
        lastAutoScroll = Date.now();
        logScroller.scrollTop = 0; // 0 is the bottom in column-reverse
    }
}

// Expose save/restore scroll position for content changes
export { saveScrollPosition };

// Click the list toggle button to show/hide the sessions pane.
export function toggleSessionsPane(): void {
    listToggle.click();
}

// Return whether the sessions pane is currently visible.
export function isSessionsPaneVisible(): boolean {
    return root.classList.contains("listOpen");
}

// Show/hide the sessions pane programmatically.
export function setSessionsPaneVisible(visible: boolean): void {
    root.classList.toggle("listOpen", visible);
}