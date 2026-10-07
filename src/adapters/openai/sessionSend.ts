import * as ledger from "../../ledger";
import { buildImageParts } from "./imageParts";
import { buildTimeGapNotice } from "./timeGapNotice";
import { ChatMessage, ContentPart, OpenAIAdapterConfig } from "./types";

export interface UserTurnContext {
    cfg: OpenAIAdapterConfig;
    sessionId: string;
    messages: ChatMessage[];
    turnSeq: number;
    led(role: string, content: unknown, extra?: Record<string, unknown>): void;
}

export interface UserTurnInput {
    text: string;
    images?: string[];
    preamble?: string[];
    /** Resume existing history, but never reuse the backend turn id. */
    retry?: boolean;
    intentId?: string;
}

/**
 * Pushes the dangling-turn gap notice, the preamble developer/system rows and
 * the user message. Returns false when a retry resumes the existing user message
 * instead of pushing a new one (the caller must then leave the objective as is).
 */
export function appendUserTurn(ctx: UserTurnContext, input: UserTurnInput): boolean {
    const { cfg, sessionId, messages, turnSeq } = ctx;
    const { text, images, preamble, retry, intentId } = input;
    // A retry resumes the existing history, including completed tool results.
    // Reposting the original instruction can make the provider repeat its work.
    const previousUser = [...messages].reverse().find((message) => message.role === "user");
    const previousText =
        typeof previousUser?.content === "string"
            ? previousUser.content
            : Array.isArray(previousUser?.content)
              ? previousUser.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("")
              : undefined;
    if (retry === true && previousText === text) return false;

    // One-shot app instructions (todo capability, autonomy, policy) go in as
    // `developer` messages — above the user turn, below the preset's system —
    // instead of being glued onto the user text. Downgraded to `system` for
    // gateways that don't accept the developer role.
    const role = cfg.supportsDeveloperRole !== false ? "developer" : "system";
    // If the previous turn was interrupted (steer/cancel) it left a dangling
    // user message with no assistant reply. Sending another user message would
    // break role alternation (Anthropic-backed providers 400 on user→user).
    // Close the gap with a short assistant turn so the new user is valid.
    const last = messages[messages.length - 1];
    if (last?.role === "user") {
        messages.push({ role: "assistant", content: "(previous turn interrupted)" });
        ctx.led("assistant", "(previous turn interrupted)");
    }
    const gapNote = buildTimeGapNotice(cfg, sessionId);
    const fullPreamble = gapNote ? [gapNote, ...(preamble ?? [])] : (preamble ?? []);
    for (const p of fullPreamble) {
        if (p && p.trim()) {
            messages.push({ role, content: p });
            ledger.appendMessage(sessionId, { role, content: p, turn: turnSeq + 1 });
        }
    }
    const imageParts = buildImageParts(images);
    const userContent: string | ContentPart[] = imageParts.length
        ? [{ type: "text", text }, ...imageParts]
        : text;
    messages.push({ role: "user", content: userContent });
    ledger.appendMessage(sessionId, {
        role: "user",
        content: imageParts.length ? `${text}\n[${imageParts.length} image(s) attached]` : text,
        turn: turnSeq + 1,
        // The user message anticipates the upcoming turn (bumpTurn runs in
        // run()). Stamp the intent now so the row carries it even though the
        // logicalTurnId is assigned when the turn actually starts.
        ...(intentId ? { intentId } : {}),
    });
    return true;
}

/**
 * True when this user text is a real new task rather than a bare continuation
 * ("continue", "ok", "sim", …), so it should become the follow-up anchor's
 * OBJECTIVE.
 */
export function isObjectiveText(text: string): boolean {
    const taskText = text.trim();
    return (
        taskText.length >= 8 &&
        !/^(continue|continuar|segue|prossiga|go on|keep going|ok|sim|yes|y)\b/i.test(taskText)
    );
}
