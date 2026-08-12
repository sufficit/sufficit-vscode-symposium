import type { SessionInfo, SessionStartOptions } from "../adapters/types";
import type { SurfaceDialoguesDeps } from "./surfaceDialoguesTypes";
import type { WebviewToHost } from "../protocol/chat";

/**
 * Branch flows for a chat surface: restart-from-message and edit-and-resend.
 * Each starts a fresh session on the same backend, seeded with the visible
 * conversation up to (but excluding) the chosen message, then re-delivers the
 * message text. Extracted from SurfaceDialogues as free functions following the
 * collaborator + deps-bag pattern; the surface
 * stays the owner of session state and is reached here via the deps bag plus an
 * openDialogue callback.
 */

/** CLI backends can retry unchanged text in their native session. */
const CLI_BACKENDS = new Set(["claude", "codex", "copilot"]);

/**
 * Lineage the branched session should inherit so it groups under the same
 * conversation as its predecessor. Every backend receives this application-
 * level link: native CLI rollouts do not reliably set parent_thread_id for a
 * fresh seeded session (Codex exec is one example), so excluding CLI backends
 * creates an orphan conversation after Edit & resend.
 */
function inheritedLineage(current: { lineageId?: string; sessionId?: string }): string | undefined {
    return current.lineageId || current.sessionId;
}
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
function buildSeedHistory(
    transcript: string | undefined,
    relation: { parentId?: string; lineageId?: string },
): string | undefined {
    const reference = relation.parentId
        ? ` Parent session: ${relation.parentId}; lineage: ${relation.lineageId || relation.parentId}.`
        : "";
    if (!transcript) {
        return reference
            ? `[Conversation restarted from its first message.]${reference}`
            : undefined;
    }
    return (
        `[Conversation continued from an earlier point.]${reference} Treat the conversation below as the complete history so far.\n\n` +
        `=== Conversation so far ===\n${transcript}\n=== End of conversation so far ===`
    );
}

function sameTextRetry(backend: string, original: string | undefined, edited: string): boolean {
    // CLI adapters (Claude/Codex/Copilot) own their native transcript and can
    // resume the same session after a failed turn. If the user clicked
    // "Edit & retry" and submitted the unchanged text, that is a retry, not a
    // history rewrite; branching here creates a duplicate Claude session in the
    // sidebar and loses the CLI-native continuity. Real edits still branch below.
    return CLI_BACKENDS.has(backend) && original === edited;
}

/**
 * Plain retry after a transient failure (timeout/dropped connection/504 —
 * see messages.ts's isTimeoutError): re-sends the SAME text to the CURRENT
 * session, never branching. Unlike restartFromMessage, this is not a
 * deliberate "restart from an earlier point" — the text is identical and the
 * user just wants the request re-issued in place. Each adapter's own send()
 * already copes with a dangling unanswered user message from the failed turn
 * (e.g. the openai adapter's "(previous turn interrupted)" filler).
 */
export function retryLastMessage(
    d: SurfaceDialoguesDeps,
    index: number,
    errorMessage?: string,
): void {
    const from = d.getController();
    if (!from || !Number.isInteger(index) || index < 0) {
        return;
    }
    const transcriptMessages = from.transcriptMessages();
    const adjustedIndex = Math.min(index, transcriptMessages.length - 1);
    if (adjustedIndex < 0) {
        return;
    }
    const original = transcriptMessages[adjustedIndex];
    if (!original || original.role !== "user") {
        return;
    }
    // Tell the model WHY it's being nudged to continue — otherwise a bare
    // resend looks like the user just said "continue" for no reason. Passed
    // in from the webview's click (not captured host-side): an in-memory
    // host field wouldn't survive a reload between the error and this click,
    // but the rendered error text does (it's restored from persisted history).
    const interruptedBy = errorMessage;
    if (interruptedBy) {
        // Visible confirmation (same status-notice channel as compaction/
        // gap notices) — the note itself is a developer-role message the
        // model sees but never renders as a chat bubble, so without this the
        // user has no way to tell it was actually sent. anchorIndex links back
        // to the original message instead of rendering a duplicate bubble.
        d.post({
            type: "event",
            event: {
                kind: "status-notice",
                text: `Continuing — told the model why: ${interruptedBy}`,
                anchorIndex: adjustedIndex,
            },
        });
    }
    // Delivery 1C: tell the adapter to REUSE the failed turn's logicalTurnId
    // (when available) so the retry is attributable to the original turn — not a
    // new logical turn with a duplicate user message. Falls back to a fresh turn
    // when the id is unknown (e.g. after a reload).
    // Keep a marker even after reload, when the host no longer knows the old
    // backend id. The adapter uses presence to preserve the dangling user row;
    // it still allocates a fresh backend turn id for every attempt.
    const retryOf = from.lastTurnId ?? "retry";
    dispatchAhp(d, {
        type: "send",
        text: original.text,
        mode: "send",
        interruptedBy,
        retryOf,
    } as WebviewToHost);
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
    // The webview sends a conversation-row index (one entry per user/assistant
    // bubble). transcriptMessages() rebuilds that same row sequence from the
    // render log, so the index maps 1:1; clamp only for stale UI clicks.
    const transcriptMessages = from.transcriptMessages();
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
    const lineageId = inheritedLineage(from);
    const seedHistory = buildSeedHistory(transcript, { parentId: from.sessionId, lineageId });
    const backend = from.backend;
    const title = from.title;
    const cwd = from.cwd;

    openDialogue(backend, { cwd, seedHistory, lineageId }, title);
    // Carry the history BEFORE the restarted message into the new branch — the
    // restarted user message itself is re-sent just below, so including it here
    // would render the user's bubble twice (once carried, once on resend).
    const carried = messages.slice(0, -1);
    if (carried.length) {
        d.post({
            type: "history",
            messages: carried,
            carried: true,
            branchLabel: {
                title: "Branched from earlier message",
                detail: `${carried.length} message${carried.length === 1 ? "" : "s"} carried into this new conversation`,
            },
        });
    }
    // Resend the user message to start the agent
    dispatchAhp(d, {
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
        dispatchAhp(d, { ...sendMsg, editFrom: undefined } as WebviewToHost);
        return;
    }
    // Same conversation-row index space as restartFromMessage. anchorIndex 0
    // yields keepTo = -1 below, so the branch starts from scratch when editing
    // the first message.
    const transcriptMessages = from.transcriptMessages();
    const adjustedIndex = Math.min(anchorIndex, transcriptMessages.length - 1);
    if (adjustedIndex < 0) {
        // No valid index, treat as normal send.
        dispatchAhp(d, { ...sendMsg, editFrom: undefined } as WebviewToHost);
        return;
    }
    if (!("text" in sendMsg) || typeof sendMsg.text !== "string") {
        return;
    }
    const original = transcriptMessages[adjustedIndex];
    if (original?.role === "user" && sameTextRetry(from.backend, original.text, sendMsg.text)) {
        dispatchAhp(d, { ...sendMsg, editFrom: undefined } as WebviewToHost);
        return;
    }
    const keepTo = adjustedIndex - 1; // exclude the message being edited
    const messages = from.transcriptMessagesUpTo(keepTo);
    const transcript = from.transcriptUpTo(keepTo);
    const lineageId = inheritedLineage(from);
    const seedHistory = buildSeedHistory(transcript, { parentId: from.sessionId, lineageId });
    openDialogue(from.backend, { cwd: from.cwd, seedHistory, lineageId }, from.title);
    if (messages.length) {
        d.post({ type: "history", messages, carried: true });
    }
    dispatchAhp(d, {
        type: "send",
        text: sendMsg.text,
        attachments:
            "attachments" in sendMsg && Array.isArray(sendMsg.attachments)
                ? sendMsg.attachments
                : [],
        model: "model" in sendMsg && typeof sendMsg.model === "string" ? sendMsg.model : undefined,
        reasoning:
            "reasoning" in sendMsg && typeof sendMsg.reasoning === "string"
                ? sendMsg.reasoning
                : undefined,
        permission:
            "permission" in sendMsg && typeof sendMsg.permission === "string"
                ? sendMsg.permission
                : undefined,
        autonomy:
            "autonomy" in sendMsg && typeof sendMsg.autonomy === "string"
                ? sendMsg.autonomy
                : undefined,
        mode: "send",
    });
}

function dispatchAhp(d: SurfaceDialoguesDeps, message: WebviewToHost): void {
    if (!d.dispatchAhp(message)) {
        throw new Error("AHP session is unavailable");
    }
}
