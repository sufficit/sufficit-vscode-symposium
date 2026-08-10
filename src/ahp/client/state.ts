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

    apply(envelope: ActionEnvelope): boolean {
        if (envelope.serverSeq <= this.lastServerSeq) return false;
        this.lastServerSeq = envelope.serverSeq;
        if (envelope.rejectionReason) return true;
        if (envelope.channel === "ahp-root://" && this.root) {
            this.root = rootReducer(this.root, envelope.action as never);
            return true;
        }
        const session = this.sessions.get(envelope.channel);
        if (session) {
            this.sessions.set(envelope.channel, sessionReducer(session, envelope.action as never));
            return true;
        }
        const chat = this.chats.get(envelope.channel);
        if (chat) {
            this.chats.set(envelope.channel, chatReducer(chat, envelope.action as never));
            return true;
        }
        return false;
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
