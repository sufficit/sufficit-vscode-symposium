import type { WebviewToHost } from "../protocol/chat";
import { retryAvailability } from "./retryAvailability";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

export function handleSurfaceRetry(
    message: Extract<WebviewToHost, { type: "retry-last-message" }>,
    deps: SurfaceMessagesDeps,
): void {
    if (retryAvailability(message.retryAt).waiting) {
        deps.post({
            type: "toast",
            text: "Retry is not available until the provider limit resets.",
        });
        return;
    }
    if (!deps.dialogues.retryLastMessage(message.index, message.errorMessage, message.text)) {
        deps.post({ type: "busy", busy: false });
        deps.post({
            type: "toast",
            text: "Retry could not be started. Reopen the session and try again.",
        });
    }
}
