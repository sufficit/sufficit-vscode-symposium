import type { HostToWebview } from "../../protocol/chat";
import type { AhpMessagePortEnvelope } from "../../ahp/messagePortProtocol";
import { SymposiumAhpState } from "../../ahp/client/state";
import { ahpActionToLegacy, ahpChatToLegacy } from "../../ahp/client/legacyView";

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
        return ahpChatToLegacy(state.chats.get(frame.snapshot.resource)!).filter(
            (item) => item.type !== "clear",
        );
    }
    if (!state.apply(frame.envelope)) return [];
    return ahpActionToLegacy(frame.envelope, state.chats.get(frame.envelope.channel));
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
