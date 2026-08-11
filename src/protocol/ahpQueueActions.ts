import type { HostToWebview, WebviewToHost } from "./chat";

interface EditablePendingMessage {
    text: string;
    attachments: string[];
}

export interface AhpQueueActionClient<Resource> {
    removeQueued(chat: Resource, id: string): void;
    promoteQueued(chat: Resource, id: string): void;
    clearQueued(chat: Resource): void;
    pendingMessage(chat: Resource, id: string): EditablePendingMessage | undefined;
}

/** Shared queue-control router for browser AHP clients. Returning true means
 * the command belongs to this router even when no chat is currently bound. */
export function routeAhpQueueAction<Resource>(
    client: AhpQueueActionClient<Resource>,
    chat: Resource | undefined,
    message: WebviewToHost,
    deliver: (message: HostToWebview) => void,
): boolean {
    switch (message.type) {
        case "queue-remove":
            if (chat !== undefined) client.removeQueued(chat, String(message.id));
            return true;
        case "queue-edit": {
            if (chat !== undefined) {
                const id = String(message.id);
                const pending = client.pendingMessage(chat, id);
                if (pending) deliver({ type: "load-input", ...pending });
                client.removeQueued(chat, id);
            }
            return true;
        }
        case "queue-promote":
            if (chat !== undefined) client.promoteQueued(chat, String(message.id));
            return true;
        case "queue-clear":
            if (chat !== undefined) client.clearQueued(chat);
            return true;
        default:
            return false;
    }
}
