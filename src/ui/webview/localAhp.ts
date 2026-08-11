import type { HostToWebview } from "../../protocol/chat";
import type { AhpMessagePortEnvelope } from "../../ahp/messagePortProtocol";
import { SymposiumAhpState } from "../../ahp/client/state";
import {
    ahpActionToLegacy,
    ahpChatToLegacy,
    rejectedEnvelopeFallback,
} from "../../ahp/client/legacyView";
import { setHasMoreHistory } from "./scroll";

let generation = 0;
let state = new SymposiumAhpState();
let caughtUpTimer: ReturnType<typeof setTimeout> | undefined;

/** Reduces one local AHP frame and returns temporary legacy render messages. */
export function applyLocalAhpFrame(message: unknown): HostToWebview[] | undefined {
    const envelope = message as Partial<AhpMessagePortEnvelope>;
    const isAhpFrame = envelope.type === "ahp-frame";
    if (!isAhpFrame) return undefined;
    if (!envelope.frame) return [];
    const frame = envelope.frame;
    if (frame.generation < generation) return [];
    if (frame.kind === "reset") {
        generation = frame.generation;
        state = new SymposiumAhpState();
        setHasMoreHistory(false);
        return [];
    }
    if (frame.generation !== generation) return [];
    if (frame.kind === "status") {
        updateConnectionStatus(frame.status, frame.detail);
        return [];
    }
    if (frame.kind === "snapshot") {
        state.applySnapshot(frame.snapshot);
        if (!frame.snapshot.resource.startsWith("ahp-chat:")) return [];
        const chatState = state.chats.get(frame.snapshot.resource);
        // Propagate the pagination cursor so the webview knows older history
        // is available for scroll-up lazy loading.
        setHasMoreHistory(
            !!(chatState as { turnsNextCursor?: string } | undefined)?.turnsNextCursor,
        );
        return ahpChatToLegacy(chatState!).filter((item) => item.type !== "clear");
    }
    const result = state.apply(frame.envelope);
    if (result === "ignored") return [];
    if (result === "rejected") {
        // The reducer never ran (see SymposiumAhpState.apply) — translating
        // this envelope through ahpActionToLegacy would render UI for a
        // mutation that never happened (D1/D2/D3 in the hardening plan).
        return rejectedEnvelopeFallback(frame.envelope, state.chats.get(frame.envelope.channel));
    }
    const action = frame.envelope.action as unknown as Record<string, unknown>;
    const legacy = ahpActionToLegacy(frame.envelope, state.chats.get(frame.envelope.channel));
    // chat/turnsLoaded is the scroll-up pagination path: the reducer prepended
    // older turns to ChatState.turns, and ahpActionToLegacy rendered them as
    // individual user/event messages. Wrap them in a history-prepend envelope so
    // the dispatcher inserts them at the TOP of the log (preserving scroll)
    // instead of appending below the current transcript.
    if (action.type === "chat/turnsLoaded") {
        const chatState = state.chats.get(frame.envelope.channel);
        setHasMoreHistory(
            !!(chatState as { turnsNextCursor?: string } | undefined)?.turnsNextCursor,
        );
        if (legacy.length > 0) {
            return [{ type: "history-prepend", messages: legacy } as HostToWebview];
        }
        return [];
    }
    return legacy;
}

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
