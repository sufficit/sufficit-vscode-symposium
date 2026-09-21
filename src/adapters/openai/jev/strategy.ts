/**
 * Pure jev decision rules (port of the Genius DefaultCompactionStrategy
 * invariants, adapted to the OpenAI message shape). No I/O, no scorer calls:
 * takes extracted blocks plus already-validated scores and turns them into
 * decisions, then applies decisions by REWRITING a copy of the messages.
 *
 * Invariants mirrored from Genius:
 * 1 — untouched messages keep content and order (decisions never rewrite text
 *     except an explicit truncation);
 * 2 — only complete, unpinned pairs get non-keep decisions;
 * 3 — KeepResult wins; then KeepCall truncates the result (never into a
 *     bigger output); else the pair is dropped (call entry + result message);
 * 4 — a prune below the minimum reduction ratio is refused, except under
 *     severe budget pressure (≥ 90% of the window) where any real reduction
 *     beats losing whole history.
 */

import type { ChatMessage } from "../types";
import type { JevBlock, JevDecision, JevScore, JevSettings } from "./types";

/** Pressure high enough (≥ 90%) to accept a smaller reduction than the gate. */
const JEV_RESCUE_PRESSURE = 0.9;

export interface JevPruneOutcome {
    decisions: JevDecision[];
    kept: number;
    truncated: number;
    dropped: number;
    charactersBefore: number;
    charactersAfter: number;
    /** (before − after) / before; 0 when there is nothing to measure. */
    ratio: number;
}

/** Decides per-candidate actions and computes the projected reduction. Pure. */
export function decideJevPrune(
    blocks: JevBlock[],
    candidates: JevBlock[],
    scores: Map<string, JevScore>,
    settings: Pick<JevSettings, "keepThreshold" | "truncateHeadChars">,
): JevPruneOutcome {
    const decisions: JevDecision[] = [];
    let kept = 0;
    let truncated = 0;
    let dropped = 0;
    let saved = 0;
    for (const block of candidates) {
        const score = scores.get(block.blockId);
        if (!score) {
            kept++;
            decisions.push({ blockId: block.blockId, action: "keep" });
            continue;
        }
        if (score.keepResult >= settings.keepThreshold) {
            kept++;
            decisions.push({ blockId: block.blockId, action: "keep" });
            continue;
        }
        if (score.keepCall >= settings.keepThreshold) {
            const head = block.resultText.slice(0, settings.truncateHeadChars);
            if (head.length >= block.resultText.length) {
                // Never truncate into a bigger output.
                kept++;
                decisions.push({ blockId: block.blockId, action: "keep" });
                continue;
            }
            truncated++;
            saved += block.resultText.length - head.length;
            decisions.push({ blockId: block.blockId, action: "truncate", head });
            continue;
        }
        dropped++;
        saved += block.contentCharacters;
        decisions.push({ blockId: block.blockId, action: "drop" });
    }
    const charactersBefore = blocks.reduce((sum, block) => sum + block.contentCharacters, 0);
    const charactersAfter = charactersBefore - saved;
    const ratio =
        charactersBefore > 0 ? (charactersBefore - charactersAfter) / charactersBefore : 0;
    return { decisions, kept, truncated, dropped, charactersBefore, charactersAfter, ratio };
}

/** The Genius reduction gate: refuse puny prunes unless the window is about to overflow. */
export function passesReductionGate(
    outcome: JevPruneOutcome,
    settings: Pick<JevSettings, "minReductionRatio">,
    pressure: number,
): boolean {
    return outcome.ratio >= settings.minReductionRatio || pressure >= JEV_RESCUE_PRESSURE;
}

/** Note appended to a truncated result, pointing at recovery — never at re-running tools. */
const JEV_TRUNCATION_NOTE =
    "\n…[pruned for context — full result preserved in the session ledger; recover via read_session]";

interface JevApplyResult {
    messages: ChatMessage[];
    dropped: number;
    truncated: number;
}

/**
 * Applies drop/truncate decisions to a COPY of the messages. Dropping a pair
 * removes the tool result message and the call entry from its assistant
 * message; an assistant message left with no calls and no content is removed
 * entirely. Truncating replaces the result text with the head + recovery note.
 * Pure with respect to the input array (returns a new one).
 */
export function applyJevDecisions(
    messages: ChatMessage[],
    decisions: JevDecision[],
): JevApplyResult {
    const actionById = new Map<string, JevDecision>();
    for (const decision of decisions) {
        if (decision.action !== "keep") {
            actionById.set(decision.blockId, decision);
        }
    }
    const dropIds = new Set(decisions.filter((d) => d.action === "drop").map((d) => d.blockId));
    const out: ChatMessage[] = [];
    let dropped = 0;
    let truncated = 0;
    for (const message of messages) {
        if (message.role === "tool" && message.tool_call_id) {
            if (dropIds.has(message.tool_call_id)) {
                dropped++;
                continue; // remove the result message
            }
            const decision = actionById.get(message.tool_call_id);
            if (decision?.action === "truncate" && typeof message.content === "string") {
                truncated++;
                out.push({
                    ...message,
                    content: `${decision.head ?? ""}${JEV_TRUNCATION_NOTE}`,
                });
                continue;
            }
            out.push(message);
            continue;
        }
        if (message.role === "assistant" && message.tool_calls?.length) {
            const calls = message.tool_calls.filter((call) => !dropIds.has(call.id));
            if (calls.length === message.tool_calls.length) {
                out.push(message);
                continue;
            }
            const hasContent =
                (typeof message.content === "string" && message.content.length > 0) ||
                Array.isArray(message.content);
            if (calls.length === 0 && !hasContent) {
                continue; // the call was the whole message
            }
            out.push({ ...message, tool_calls: calls.length > 0 ? calls : undefined });
            continue;
        }
        out.push(message);
    }
    return { messages: out, dropped, truncated };
}
