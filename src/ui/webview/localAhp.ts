import type { AhpMessagePortEnvelope } from "../../ahp/messagePortProtocol";
import { SymposiumAhpState } from "../../ahp/client/state";
import { setHasMoreHistory } from "./scroll";
import {
    resetAhpChatRendering,
    scheduleAhpChatAction,
    scheduleAhpChatSnapshot,
    whenAhpChatRenderIdle,
} from "./ahpChatView";

let generation = 0;
let state = new SymposiumAhpState();
let caughtUpTimer: ReturnType<typeof setTimeout> | undefined;

/** Reduces and renders one local AHP frame. */
export function applyLocalAhpFrame(message: unknown): boolean {
    const envelope = message as Partial<AhpMessagePortEnvelope>;
    const isAhpFrame = envelope.type === "ahp-frame";
    if (!isAhpFrame) return false;
    if (!envelope.frame) return true;
    const frame = envelope.frame;
    if (frame.generation < generation) return true;
    if (frame.kind === "reset") {
        generation = frame.generation;
        state = new SymposiumAhpState();
        resetAhpChatRendering();
        setHasMoreHistory(false);
        return true;
    }
    if (frame.generation !== generation) return true;
    if (frame.kind === "status") {
        updateConnectionStatus(frame.status, frame.detail);
        return true;
    }
    if (frame.kind === "snapshot") {
        state.applySnapshot(frame.snapshot);
        if (!frame.snapshot.resource.startsWith("ahp-chat:")) return true;
        const chatState = state.chats.get(frame.snapshot.resource);
        // Propagate the pagination cursor so the webview knows older history
        // is available for scroll-up lazy loading.
        setHasMoreHistory(
            !!(chatState as { turnsNextCursor?: string } | undefined)?.turnsNextCursor,
        );
        if (chatState) void scheduleAhpChatSnapshot(chatState);
        return true;
    }
    const result = state.apply(frame.envelope);
    if (result === "ignored") return true;
    void scheduleAhpChatAction(frame.envelope, state.chats.get(frame.envelope.channel));
    return true;
}

export { whenAhpChatRenderIdle };

function updateConnectionStatus(status: string, detail?: string): void {
    const element = document.getElementById("ahpConnectionStatus");
    if (!element) return;
    if (caughtUpTimer) clearTimeout(caughtUpTimer);
    const labels: Record<string, string> = {
        connecting: "Connecting…",
        reconciling: "Synchronizing…",
        "caught-up": "Synchronized",
        failed: "Synchronization failed",
    };
    element.textContent = detail
        ? `${labels[status] ?? status}: ${detail}`
        : (labels[status] ?? status);
    element.dataset.state = status;
    element.hidden = false;
    if (status === "caught-up") {
        caughtUpTimer = setTimeout(() => {
            element.hidden = true;
        }, 1800);
    }
}
