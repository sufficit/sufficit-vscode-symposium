/**
 * Pure jev fitting (port of the Genius plugin's JevFitting): builds the wire
 * request shape from the live messages. The STATE is the ordered conversation
 * with tool results omitted and long texts abbreviated; each candidate pair
 * becomes TWO named noul questions (`<id>.call`, `<id>.result`) carrying their
 * own content in the instructions. A pair is never divided across batches;
 * state + questions + envelope of one request must fit the request budget.
 * No I/O, no clock — testable.
 */

import type { ChatMessage } from "../types";
import { estimateTokens } from "./blocks";
import type { JevBlock, JevWireQuestion } from "./types";

/** Chars-per-token heuristic, one estimator everywhere (state, questions, budgets). */
const CHARS_PER_TOKEN = 4;
const STATE_TEXT_CAP_CHARS = 2_000;
const RESULT_HEAD_CAP_CHARS = 500;
const ENVELOPE_TOKENS = 16;
const PRESET_ID_TOKENS = 13;

const JEV_MAX_STATE_TOKENS = 25_000;
const JEV_MAX_REQUEST_TOKENS = 30_000;
const JEV_MAX_BATCHES = 8;

const CALL_QUESTION = "Must this tool call stay readable for the work ahead?";
const RESULT_QUESTION = "Must this result stay readable to answer follow-ups?";
const CALL_TRUE = "The call must stay readable";
const CALL_FALSE = "The call can be dropped";
const RESULT_TRUE = "The result must stay readable";
const RESULT_FALSE = "The result can be dropped";

/** One wire question: a candidate half plus its judgement. */
export interface JevQuestion {
    blockId: string;
    name: string;
    instructions: string;
    criteriaTrue: string;
    criteriaFalse: string;
}

/** Questions packed into one request, with the repeated-state token estimate. */
export interface JevBatch {
    questions: JevQuestion[];
    estimatedTokens: number;
}

/** The fitted plan for one scoring operation. */
interface JevFit {
    state: string;
    stateTokens: number;
    batches: JevBatch[];
}

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

function abbreviate(text: string): string {
    const head = text.slice(0, STATE_TEXT_CAP_CHARS / 2);
    const tail = text.slice(Math.max(0, text.length - STATE_TEXT_CAP_CHARS / 4));
    return `${head}\n…[${text.length} chars total, abbreviated for scoring]\n${tail}`;
}

/** The ordered conversation as one text: results omitted, long texts abbreviated. */
function buildJevState(messages: ChatMessage[]): { state: string; stateTokens: number } {
    const lines: string[] = [];
    for (const message of messages) {
        if (message.role === "tool") {
            continue; // the scorer judges a result from its own question
        }
        const calls = message.role === "assistant" ? message.tool_calls : undefined;
        if (calls?.length) {
            for (const call of calls) {
                lines.push(`${call.function?.name ?? call.id}(${call.function?.arguments ?? ""})`);
            }
            continue;
        }
        const text = contentToText(message.content);
        if (text) {
            lines.push(text.length <= STATE_TEXT_CAP_CHARS ? text : abbreviate(text));
        }
    }
    const state = lines.join("\n");
    return { state, stateTokens: Math.ceil(state.length / CHARS_PER_TOKEN) };
}

function resultHead(resultText: string): string {
    return resultText.length > RESULT_HEAD_CAP_CHARS
        ? `${resultText.slice(0, RESULT_HEAD_CAP_CHARS)}…[${resultText.length} chars]`
        : resultText;
}

/** The two questions of one candidate block. */
function newJevQuestions(block: JevBlock): { call: JevQuestion; result: JevQuestion } {
    return {
        call: {
            blockId: block.blockId,
            name: `${block.blockId}.call`,
            instructions: `${block.callLine}\n\n${CALL_QUESTION}`,
            criteriaTrue: CALL_TRUE,
            criteriaFalse: CALL_FALSE,
        },
        result: {
            blockId: block.blockId,
            name: `${block.blockId}.result`,
            instructions: `${resultHead(block.resultText)}\n\n${RESULT_QUESTION}`,
            criteriaTrue: RESULT_TRUE,
            criteriaFalse: RESULT_FALSE,
        },
    };
}

function questionTokens(question: JevQuestion): number {
    const wire: JevWireQuestion = {
        type: "noul",
        instructions: question.instructions,
        criteria: { true: question.criteriaTrue, false: question.criteriaFalse },
    };
    return estimateTokens(`"${question.name}":`) + estimateTokens(JSON.stringify(wire));
}

/**
 * Packs candidate pairs into batches. Throws when the state exceeds its budget
 * or a single pair cannot fit any request — callers treat that as "no scoring,
 * context untouched" (fail-safe).
 */
export function fitJevBatches(
    messages: ChatMessage[],
    candidates: JevBlock[],
    options: {
        presetId?: string;
        maxStateTokens?: number;
        maxRequestTokens?: number;
        maxBatches?: number;
    } = {},
): JevFit {
    const maxStateTokens = options.maxStateTokens ?? JEV_MAX_STATE_TOKENS;
    const maxRequestTokens = options.maxRequestTokens ?? JEV_MAX_REQUEST_TOKENS;
    const maxBatches = options.maxBatches ?? JEV_MAX_BATCHES;
    const { state, stateTokens } = buildJevState(messages);
    if (stateTokens > maxStateTokens) {
        throw new Error(
            `jev state does not fit: ${stateTokens} tokens > ${maxStateTokens} even after abbreviation`,
        );
    }
    const envelopeTokens = ENVELOPE_TOKENS + (options.presetId ? PRESET_ID_TOKENS : 0);
    const batches: JevQuestion[][] = [[]];
    let batchTokens = stateTokens + envelopeTokens;
    for (const block of candidates) {
        const { call, result } = newJevQuestions(block);
        const pairTokens = questionTokens(call) + questionTokens(result);
        if (stateTokens + envelopeTokens + pairTokens > maxRequestTokens) {
            throw new Error(
                `jev question pair ${block.blockId} cannot fit any request: ${pairTokens} tokens`,
            );
        }
        if (batchTokens + pairTokens > maxRequestTokens) {
            batches.push([]);
            batchTokens = stateTokens + envelopeTokens;
        }
        batches[batches.length - 1].push(call, result); // never split a pair
        batchTokens += pairTokens;
    }
    if (batches.length > maxBatches) {
        throw new Error(`jev fitting needs ${batches.length} batches > max ${maxBatches}`);
    }
    return {
        state,
        stateTokens,
        batches: batches
            .filter((questions) => questions.length > 0)
            .map((questions) => ({
                questions,
                estimatedTokens:
                    stateTokens +
                    envelopeTokens +
                    questions.reduce((sum, q) => sum + questionTokens(q), 0),
            })),
    };
}
