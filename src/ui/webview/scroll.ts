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

// Bottom-pinning (Copilot-style lock-to-bottom): while the user sits at the
// bottom the view is "pinned" — every content growth re-snaps instantly, so a
// restored session opens already at the last message and late layout (fonts,
// images, streamed history) extends the scrollbar upward without moving the
// view. Scrolling up unpins; the browser's native scroll anchoring then keeps
// the reading position stable. Scrolling back to the bottom re-pins.
export function nearBottom(): boolean { return logScroller.scrollHeight - logScroller.scrollTop - logScroller.clientHeight < 80; }
// Timestamp of the last PROGRAMMATIC scroll, so the ctx-menu auto-close can tell
// it apart from a user scroll. Read by the document scroll handler in index.
export let lastAutoScroll = 0;
let pinned = true;   // an empty/new log starts pinned
function snapToBottom(): void { lastAutoScroll = Date.now(); logScroller.scrollTop = logScroller.scrollHeight; }
export function autoScroll(stick: boolean): void { if (stick) { pinned = true; snapToBottom(); } }
export function scrollToBottom(): void {
    pinned = true;
    snapToBottom();
    updateScrollBtn();
}
// The pin follows the user's scroll: at the bottom → pinned, away → unpinned.
// Ignore the scroll events our own snaps produce (they're always at-bottom
// anyway, but the timestamp guard keeps a mid-frame unpin from a programmatic
// scroll racing a user wheel event).
logScroller.addEventListener("scroll", () => {
    if (Date.now() - lastAutoScroll > 120) { pinned = nearBottom(); }
}, { passive: true });
// Content grew (history restore, streaming, images/fonts settling): keep the
// view glued to the newest message while pinned.
new ResizeObserver(() => {
    if (pinned) { snapToBottom(); }
    updateScrollBtn();
}).observe(log);

// Floating "scroll to bottom" button: visible only when scrolled up.
let scrollBtn: any = null;
export function updateScrollBtn(): void {
    if (!scrollBtn) { return; }
    scrollBtn.classList.toggle("show", !nearBottom() && log.childElementCount > 0);
}
logScroller.addEventListener("scroll", updateScrollBtn);
scrollBtn = document.getElementById("scrollBottom");
if (scrollBtn) { scrollBtn.addEventListener("click", scrollToBottom); }
// Show the empty-state placeholder when the log has no messages yet.
export function refreshEmpty(): void { root.classList.toggle("empty", log.childElementCount === 0); }

let stickyUserMessage: HTMLElement | null = null;

export function armStickyUserMessage(el: HTMLElement): void {
    // Clear previous sticky
    if (stickyUserMessage && stickyUserMessage !== el) {
        stickyUserMessage.classList.remove("stickyUser");
    }
    stickyUserMessage = el;
    // Don't apply sticky immediately - only on scroll
}

export function clearStickyUserMessage(): void {
    stickyUserMessage?.classList.remove("stickyUser");
    stickyUserMessage = null;
}

// Check sticky state on scroll: apply when user message scrolled out of view upward
// Only activate when user manually scrolls up (not at bottom)
function updateStickyState(): void {
    if (!stickyUserMessage) { return; }

    // Don't apply sticky if we're at or near bottom (auto-scroll / not manually scrolled up)
    if (logScroller.scrollHeight - logScroller.scrollTop - logScroller.clientHeight < 100) {
        stickyUserMessage.classList.remove("stickyUser");
        return;
    }

    // Use the in-flow offsetTop (stable; position:sticky keeps the element in flow)
    // instead of getBoundingClientRect — whose top snaps to logRect.top the instant
    // we pin, flipping the predicate every scroll event and making the header blink.
    const shouldStick = logScroller.scrollTop >= stickyUserMessage.offsetTop;
    stickyUserMessage.classList.toggle("stickyUser", shouldStick);
}

logScroller.addEventListener("scroll", updateStickyState, { passive: true });
