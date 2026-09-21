/**
 * Extraction of scoring blocks from the live ChatMessage array. Pure module:
 * no I/O, no clock — testable. Mirrors the Genius ChatCompactionSource idea
 * adapted to the OpenAI wire shape (assistant.tool_calls[] + role:"tool"
 * results joined by tool_call_id).
 */

import type { ChatMessage } from "../types";
import type { JevBlock } from "./types";

/** Chars-per-token heuristic shared by fitting budgets (documented approximation). */
const JEV_CHARS_PER_TOKEN = 4;

function contentToText(content: ChatMessage["content"]): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
            .trim();
    }
    return "";
}

/** `name({arguments})` rendering of one tool call, used as the scoring call line. */
function toolCallLine(name: string, args: string): string {
    return `${name}(${args})`;
}

/**
 * Every tool-call/result pair in the conversation, in conversation order.
 * A pair is `complete` when the call has a tool message with non-empty text.
 */
export function extractJevBlocks(messages: ChatMessage[]): JevBlock[] {
    const blocks: JevBlock[] = [];
    const byId = new Map<string, JevBlock>();
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const calls = message.role === "assistant" ? message.tool_calls : undefined;
        if (calls) {
            for (let c = 0; c < calls.length; c++) {
                const call = calls[c];
                const callLine = toolCallLine(
                    call.function?.name ?? call.id,
                    call.function?.arguments ?? "",
                );
                const block: JevBlock = {
                    blockId: call.id,
                    callMessageIndex: i,
                    callIndex: c,
                    resultMessageIndex: -1,
                    callLine,
                    resultText: "",
                    contentCharacters: callLine.length + 2,
                    complete: false,
                };
                blocks.push(block);
                if (call.id) {
                    byId.set(call.id, block);
                }
            }
            continue;
        }
        if (message.role === "tool" && message.tool_call_id) {
            const block = byId.get(message.tool_call_id);
            const text = contentToText(message.content);
            if (block && !block.complete && block.resultMessageIndex === -1) {
                block.resultMessageIndex = i;
                block.resultText = text;
                block.contentCharacters = block.callLine.length + 2 + text.length;
                block.complete = text.length > 0;
            }
        }
    }
    return blocks;
}

/**
 * Block ids that must never be pruned: the FIRST block (conversation anchor,
 * Genius invariant 3) and every block whose call or result message sits in the
 * trailing `preserveRecentMessages` messages of the array.
 */
export function pinnedJevBlockIds(
    blocks: JevBlock[],
    totalMessages: number,
    preserveRecentMessages: number,
): Set<string> {
    const pinned = new Set<string>();
    const first = blocks[0];
    if (first) {
        pinned.add(first.blockId);
    }
    const tailStart = totalMessages - Math.max(0, preserveRecentMessages);
    for (const block of blocks) {
        if (
            block.callMessageIndex >= tailStart ||
            (block.resultMessageIndex >= 0 && block.resultMessageIndex >= tailStart)
        ) {
            pinned.add(block.blockId);
        }
    }
    return pinned;
}

/**
 * Blocks eligible for scoring: complete pairs that are not pinned. Blocks with
 * duplicate ids (malformed history) are excluded defensively — their decisions
 * would be ambiguous to apply.
 */
export function candidateJevBlocks(blocks: JevBlock[], pinned: Set<string>): JevBlock[] {
    const seen = new Set<string>();
    return blocks.filter((block) => {
        if (!block.complete || pinned.has(block.blockId) || !block.blockId) {
            return false;
        }
        if (seen.has(block.blockId)) {
            return false;
        }
        seen.add(block.blockId);
        return true;
    });
}

/** Tokens estimate over the exact wire string (same heuristic as budgets). */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / JEV_CHARS_PER_TOKEN);
}
