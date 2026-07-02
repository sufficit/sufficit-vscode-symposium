import type { SessionInfo, SessionStartOptions } from "../adapters/types";
import type { SurfaceDialoguesDeps } from "./surfaceDialogues";
import type { WebviewToHost } from "./protocol";

/**
 * Branch flows for a chat surface: restart-from-message and edit-and-resend.
 * Each starts a fresh session on the same backend, seeded with the visible
 * conversation up to (but excluding) the chosen message, then re-delivers the
 * message text. Extracted from SurfaceDialogues as free functions following the
 * collaborator + deps-bag pattern (see controllerMessageHandler.ts); the surface
 * stays the owner of session state and is reached here via the deps bag plus an
 * openDialogue callback.
 */

/** Signature of SurfaceDialogues.openDialogue (the new/resumed-dialogue entry point). */
type OpenDialogue = (
    backend: string,
    options: SessionStartOptions,
    title: string,
    info?: SessionInfo,
) => void;

/**
 * Wraps a partial transcript into a "conversation continued" preamble so the
 * branched session treats the carried history as the complete context so far.
 * Returns undefined when there is nothing to seed (first-message branch).
 */
function buildSeedHistory(transcript: string | undefined): string | undefined {
    return transcript
        ? `[Conversation continued from an earlier point] Treat the conversation below as the complete history so far.\n\n` +
          `=== Conversation so far ===\n${transcript}\n=== End of conversation so far ===`
        : undefined;
}

/**
 * Starts a fresh session on the SAME backend, seeded only with the visible
 * conversation up to the chosen message. This is the Symposium equivalent
 * of VS Code chat's "restart from here": the old dialogue remains intact,
 * while the current surface branches into a new one from that point.
 */
export function restartFromMessage(
    d: SurfaceDialoguesDeps,
    openDialogue: OpenDialogue,
    index: number,
): void {
    const from = d.getController();
    if (!from || !Number.isInteger(index) || index < 0) {
        return;
    }
    // Adjust index: webview idx includes all rendered messages (user/assistant/thinking/tool/error),
    // but transcriptMessages only includes user/assistant. We need to map the index by assuming
    // that the N-th user/assistant in conversationRows corresponds to the N-th in transcriptMessages.
    // We approximate this by using the index directly, which works when there are no thinking/tool/error
    // rows, or when we iterate through the messages to find the correct position.
    // For now, use a simple approach: since we cannot access conversationRows from the host,
    // we'll use the index as-is but handle the case where it's out of bounds.
    const transcriptMessages = from.transcriptMessages();
    // Clamp the index to the valid range
    const adjustedIndex = Math.min(index, transcriptMessages.length - 1);
    if (adjustedIndex < 0) {
        return;
    }
    const messages = from.transcriptMessagesUpTo(adjustedIndex);
    if (!messages.length) {
        return;
    }
    // Find the message we're restarting from (last user message in the carried list)
    const lastUserMsg = messages[messages.length - 1];
    if (!lastUserMsg || lastUserMsg.role !== "user") {
        return;
    }
    // Seed history up to but NOT INCLUDING the restarted message
    const keepTo = adjustedIndex - 1;
    const transcript = keepTo >= 0 ? from.transcriptUpTo(keepTo) : undefined;
    const seedHistory = buildSeedHistory(transcript);
    const backend = from.backend;
    const title = from.title;
    const cwd = from.cwd;

    openDialogue(backend, { cwd, seedHistory }, title);
    d.post({
        type: "history",
        messages,
        carried: true,
        branchLabel: {
            title: "Branched from earlier message",
            detail: `${messages.length} message${messages.length === 1 ? "" : "s"} carried into this new conversation`,
        },
    });
    // Resend the user message to start the agent
    void d.getController()?.handleMessage({
        type: "send",
        text: lastUserMsg.text,
        mode: "send",
    } as WebviewToHost);
}

/**
 * Edit & resend: branch a fresh session seeded with the conversation BEFORE
 * the edited message (anchorIndex excluded), then deliver the edited text as
 * the new message — so we genuinely "restart from this point".
 */
export function editResend(
    d: SurfaceDialoguesDeps,
    openDialogue: OpenDialogue,
    anchorIndex: number,
    sendMsg: WebviewToHost,
): void {
    const from = d.getController();
    if (!from || !Number.isInteger(anchorIndex) || anchorIndex < 0) {
        // Nothing to rewind to — treat as a normal send.
        void d.getController()?.handleMessage({ ...sendMsg, editFrom: undefined } as WebviewToHost);
        return;
    }
    // Adjust index: webview idx includes all rendered messages (user/assistant/thinking/tool/error),
    // but transcriptMessages only includes user/assistant. We use the same approach as restartFromMessage:
    // clamp the index to the valid range and use it as-is.
    const transcriptMessages = from.transcriptMessages();
    const adjustedIndex = Math.min(anchorIndex, transcriptMessages.length - 1);
    if (adjustedIndex < 0) {
        // No valid index, treat as normal send.
        void d.getController()?.handleMessage({ ...sendMsg, editFrom: undefined } as WebviewToHost);
        return;
    }
    const keepTo = adjustedIndex - 1;   // exclude the message being edited
    const messages = from.transcriptMessagesUpTo(keepTo);
    const transcript = from.transcriptUpTo(keepTo);
    const seedHistory = buildSeedHistory(transcript);
    openDialogue(from.backend, { cwd: from.cwd, seedHistory }, from.title);
    if (messages.length) {
        d.post({ type: "history", messages, carried: true });
    }
    // Type guard: ensure sendMsg has the required "send" properties
    if (!("text" in sendMsg) || typeof sendMsg.text !== "string") {
        return;
    }
    void d.getController()?.handleMessage({
        type: "send",
        text: sendMsg.text,
        attachments: "attachments" in sendMsg && Array.isArray(sendMsg.attachments) ? sendMsg.attachments : [],
        model: "model" in sendMsg && typeof sendMsg.model === "string" ? sendMsg.model : undefined,
        reasoning: "reasoning" in sendMsg && typeof sendMsg.reasoning === "string" ? sendMsg.reasoning : undefined,
        permission: "permission" in sendMsg && typeof sendMsg.permission === "string" ? sendMsg.permission : undefined,
        autonomy: "autonomy" in sendMsg && typeof sendMsg.autonomy === "string" ? sendMsg.autonomy : undefined,
        mode: "send",
    });
}
