// Layout + scroll helpers for the chat log and sessions pane. Side effects
// (ResizeObserver, scroll/listToggle listeners, initial layout) run on import.
import { root, log, logScroller, listToggle } from "./dom";
import { sideMode } from "./state";

// The sessions pane sits on the OUTER edge: docked right → sessions right;
// docked left → sessions left. With no dock-side API, infer from screen position.
export function sideIsRight(): boolean {
    if (sideMode === "left") {
        return false;
    }
    if (sideMode === "right") {
        return true;
    }
    try {
        const center = window.screenX + window.innerWidth / 2;
        return center > window.screen.width / 2;
    } catch (e) {
        return false;
    }
}

// Responsive: wide surface shows the sessions pane beside the chat; narrow hides
// it behind the toggle (mirrors the built-in chat sessions viewer).
const NARROW = 640;
let zeroWidthRetries = 0;

function surfaceWidth(): number {
    // VS Code can instantiate/reveal the webview before body.clientWidth has
    // settled. Fall back through the root/document/window measurements so the
    // first layout does not incorrectly lock the sessions pane into narrow mode
    // until the user manually resizes the editor.
    return Math.max(
        root.getBoundingClientRect().width,
        document.body.clientWidth,
        document.documentElement.clientWidth,
        window.innerWidth || 0,
    );
}

export function layout(): void {
    const width = surfaceWidth();
    if (width <= 1 && zeroWidthRetries < 8) {
        zeroWidthRetries++;
        requestAnimationFrame(layout);
        return;
    }
    zeroWidthRetries = 0;
    root.classList.toggle("narrow", width < NARROW);
    root.classList.toggle("side-right", sideIsRight());
}

export function scheduleLayout(): void {
    layout();
    // The host may apply the final editor dimensions just after scripts run or
    // after the meta payload boots the surface. A couple of cheap deferred
    // passes make the initial state deterministic without waiting for a resize.
    requestAnimationFrame(layout);
    setTimeout(layout, 50);
    setTimeout(layout, 250);
}

new ResizeObserver(scheduleLayout).observe(document.body);
window.addEventListener("resize", scheduleLayout);
window.visualViewport?.addEventListener("resize", scheduleLayout);
window.addEventListener("load", scheduleLayout);
window.addEventListener("pageshow", scheduleLayout);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        scheduleLayout();
    }
});
scheduleLayout();
listToggle.addEventListener("click", () => root.classList.toggle("listOpen"));

// Bottom-pinning (Copilot-style lock-to-bottom): while the user sits at the
// bottom the view is "pinned" — every content growth re-snaps instantly, so a
// restored session opens already at the last message and late layout (fonts,
// images, streamed history) extends the scrollbar upward without moving the
// view. Scrolling up unpins; the browser's native scroll anchoring then keeps
// the reading position stable. Scrolling back to the bottom re-pins.
export function nearBottom(): boolean {
    return logScroller.scrollHeight - logScroller.scrollTop - logScroller.clientHeight < 80;
}
// Timestamp of the last PROGRAMMATIC scroll, so the ctx-menu auto-close can tell
// it apart from a user scroll. Read by the document scroll handler in index.
export let lastAutoScroll = 0;
let pinned = true; // an empty/new log starts pinned
function snapToBottom(): void {
    lastAutoScroll = Date.now();
    logScroller.scrollTop = logScroller.scrollHeight;
}
export function autoScroll(stick: boolean): void {
    if (stick) {
        pinned = true;
        snapToBottom();
    }
}
export function scrollToBottom(): void {
    pinned = true;
    snapToBottom();
    updateScrollBtn();
}

/** Keeps restored history pinned while remote-webview layout settles. */
export function settleAtBottom(stillCurrent: () => boolean, done?: () => void): void {
    const started = performance.now();
    let stableFrames = 0;
    let previousHeight = -1;
    const step = (): void => {
        if (!stillCurrent()) {
            return;
        }
        const height = logScroller.scrollHeight;
        scrollToBottom();
        stableFrames = height === previousHeight ? stableFrames + 1 : 0;
        previousHeight = height;
        if (stableFrames >= 3 || performance.now() - started >= 750) {
            done?.();
            return;
        }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
// The pin follows the user's scroll: at the bottom → pinned, away → unpinned.
// Ignore the scroll events our own snaps produce (they're always at-bottom
// anyway, but the timestamp guard keeps a mid-frame unpin from a programmatic
// scroll racing a user wheel event).
logScroller.addEventListener(
    "scroll",
    () => {
        if (Date.now() - lastAutoScroll > 120) {
            pinned = nearBottom();
        }
    },
    { passive: true },
);
// Content grew (history restore, streaming, images/fonts settling): keep the
// view glued to the newest message while pinned.
new ResizeObserver(() => {
    if (pinned) {
        snapToBottom();
    }
    updateScrollBtn();
}).observe(log);

// Floating "scroll to bottom" button: visible only when scrolled up.
let scrollBtn: HTMLButtonElement | null = null;
export function updateScrollBtn(): void {
    if (!scrollBtn) {
        return;
    }
    scrollBtn.classList.toggle("show", !nearBottom() && log.childElementCount > 0);
}
logScroller.addEventListener("scroll", updateScrollBtn);
scrollBtn = document.querySelector<HTMLButtonElement>("#scrollBottom");
if (scrollBtn) {
    scrollBtn.addEventListener("click", scrollToBottom);
}
// Show the empty-state placeholder when the log has no messages yet.
export function refreshEmpty(): void {
    root.classList.toggle("empty", log.childElementCount === 0);
}

let stickyUserMessage: HTMLElement | null = null;
let stickyStateRaf = 0;
// Entering and leaving the sticky state cannot use the exact same pixel. The
// sticky chrome adds a border/padding, which can otherwise move the scroll
// geometry just enough to flip the predicate on the next scroll event.
const STICKY_ENTER_PX = 8;
const STICKY_EXIT_PX = 24;

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
    stickyStateRaf = 0;
    if (!stickyUserMessage) {
        return;
    }

    // Don't apply sticky if we're at or near bottom (auto-scroll / not manually scrolled up)
    if (logScroller.scrollHeight - logScroller.scrollTop - logScroller.clientHeight < 100) {
        stickyUserMessage.classList.remove("stickyUser");
        return;
    }

    // Use the in-flow offsetTop (stable; position:sticky keeps the element in flow)
    // instead of getBoundingClientRect — whose top snaps to logRect.top the instant
    // we pin, flipping the predicate every scroll event and making the header blink.
    const threshold = stickyUserMessage.offsetTop;
    const isSticky = stickyUserMessage.classList.contains("stickyUser");
    const shouldStick = isSticky
        ? logScroller.scrollTop >= threshold - STICKY_EXIT_PX
        : logScroller.scrollTop >= threshold + STICKY_ENTER_PX;
    if (shouldStick !== isSticky) {
        stickyUserMessage.classList.toggle("stickyUser", shouldStick);
    }
}

function scheduleStickyState(): void {
    if (!stickyStateRaf) {
        stickyStateRaf = requestAnimationFrame(updateStickyState);
    }
}

logScroller.addEventListener("scroll", scheduleStickyState, { passive: true });
