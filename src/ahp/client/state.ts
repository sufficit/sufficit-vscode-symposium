import type {
    ActionEnvelope,
    ChatState,
    RootState,
    SessionState,
    Snapshot,
    URI,
} from "@microsoft/agent-host-protocol";
import { chatReducer } from "../chatReducer";
import { rootReducer, sessionReducer } from "../stateReducers";

/** Outcome of applying one server-delivered envelope to local mirror state.
 *  "rejected" is distinct from "ignored": a rejected envelope still advances
 *  lastServerSeq (it was seen, just not accepted), but the reducer never ran. */
export type ApplyResult = "reduced" | "rejected" | "ignored";

/** Browser-safe mirror including chats, which the upstream convenience mirror omits. */
export class SymposiumAhpState {
    root: RootState | undefined;
    readonly sessions = new Map<URI, SessionState>();
    readonly chats = new Map<URI, ChatState>();
    lastServerSeq = 0;

    applySnapshot(snapshot: Snapshot): void {
        this.lastServerSeq = Math.max(this.lastServerSeq, snapshot.fromSeq);
        if (snapshot.resource === "ahp-root://") {
            this.root = snapshot.state as RootState;
        } else if (snapshot.resource.startsWith("ahp-session:")) {
            this.sessions.set(snapshot.resource, snapshot.state as SessionState);
        } else if (snapshot.resource.startsWith("ahp-chat:")) {
            this.chats.set(snapshot.resource, snapshot.state as ChatState);
        }
    }

    apply(envelope: ActionEnvelope): ApplyResult {
        if (envelope.serverSeq <= this.lastServerSeq) return "ignored";
        this.lastServerSeq = envelope.serverSeq;
        // A rejected client action never touches state — this mirrors
        // AhpStateStore.dispatch on the host, which also leaves channel.state
        // untouched for rejections. The seq bump above still happened, so a
        // later accepted envelope is never mistaken for a stale duplicate.
        if (envelope.rejectionReason) return "rejected";
        if (envelope.channel === "ahp-root://" && this.root) {
            this.root = rootReducer(this.root, envelope.action as never);
            return "reduced";
        }
        const session = this.sessions.get(envelope.channel);
        if (session) {
            this.sessions.set(envelope.channel, sessionReducer(session, envelope.action as never));
            return "reduced";
        }
        const chat = this.chats.get(envelope.channel);
        if (chat) {
            this.chats.set(envelope.channel, chatReducer(chat, envelope.action as never));
            return "reduced";
        }
        return "ignored";
    }

    remove(resource: URI): void {
        const session = this.sessions.get(resource);
        if (session) {
            for (const chat of session.chats) this.chats.delete(chat.resource);
        }
        this.sessions.delete(resource);
        this.chats.delete(resource);
    }
}

export function nativeSessionId(state: SessionState): string {
    const symposium = state._meta?.symposium as { nativeSessionId?: unknown } | undefined;
    return typeof symposium?.nativeSessionId === "string" ? symposium.nativeSessionId : "";
}

export function chatText(state: ChatState): string {
    return [...state.turns, ...(state.activeTurn ? [state.activeTurn] : [])]
        .flatMap((turn) => turn.responseParts)
        .filter((part) => (part as { kind?: unknown }).kind === "markdown")
        .map((part) => String((part as { content?: unknown }).content ?? ""))
        .join("");
}
