/**
 * Jev context-pruning types for the Sufficit AI adapter (feature
 * `symposium.jev`). Wire shapes mirror docs/JEV-SYSTEMONE-API-CONTRACT.md and
 * the sufficit-ai JevController: POST {endpointUrl} with
 * `{ model?, presetId?, state, questions }` where `questions` is a named
 * dictionary of noul questions; the response envelope is
 * `{ model, answers, usage }` and each answer carries the noul probability
 * keyed back to the question name.
 */

/** Default sufficit-ai jev score endpoint (the user's jev preset is the provider). */
export const JEV_DEFAULT_ENDPOINT = "https://ai.sufficit.com.br/jev/v1/score";

/** User-facing configuration read from `symposium.jev.*` settings. */
export interface JevSettings {
    /** Feature switch. Default on (Sufficit AI adapter only; gated by gateway host). */
    enabled: boolean;
    /** Absolute http(s) URL of the jev score endpoint. */
    endpointUrl: string;
    /** Optional explicit jev preset id (blank = the context's default jev preset). */
    presetId: string;
    /** Optional model override (blank = the preset backend's own model). */
    model: string;
    /** Noul probability at or above which a half is kept. */
    keepThreshold: number;
    /** Messages at the tail whose tool pairs are never pruned. */
    preserveRecentMessages: number;
    /** Characters kept when truncating a prunable tool result. */
    truncateHeadChars: number;
    /** Minimum character reduction for a prune to apply. */
    minReductionRatio: number;
    /** Minutes between prune attempts, successful or not. */
    cooldownMinutes: number;
    /** Context pressure (input/window) that triggers a prune attempt. */
    triggerPressure: number;
}

export const JEV_DEFAULT_SETTINGS: JevSettings = {
    enabled: true,
    endpointUrl: JEV_DEFAULT_ENDPOINT,
    presetId: "",
    model: "",
    keepThreshold: 0.5,
    preserveRecentMessages: 6,
    truncateHeadChars: 300,
    minReductionRatio: 0.25,
    cooldownMinutes: 5,
    triggerPressure: 0.8,
};

/** Fills unset/invalid fields with the documented defaults. Pure. */
export function normalizeJevSettings(value?: Partial<JevSettings> | null): JevSettings {
    const settings = { ...JEV_DEFAULT_SETTINGS };
    if (!value) {
        return settings;
    }
    if (typeof value.enabled === "boolean") {
        settings.enabled = value.enabled;
    }
    if (typeof value.endpointUrl === "string" && value.endpointUrl.trim()) {
        settings.endpointUrl = value.endpointUrl.trim();
    }
    if (typeof value.presetId === "string") {
        settings.presetId = value.presetId.trim();
    }
    if (typeof value.model === "string") {
        settings.model = value.model.trim();
    }
    const ratio = (candidate: unknown, fallback: number): number =>
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate > 0 &&
        candidate <= 1
            ? candidate
            : fallback;
    const count = (candidate: unknown, fallback: number): number =>
        typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
            ? candidate
            : fallback;
    settings.keepThreshold = ratio(value.keepThreshold, settings.keepThreshold);
    settings.preserveRecentMessages = count(
        value.preserveRecentMessages,
        settings.preserveRecentMessages,
    );
    settings.truncateHeadChars = count(value.truncateHeadChars, settings.truncateHeadChars);
    settings.minReductionRatio = ratio(value.minReductionRatio, settings.minReductionRatio);
    settings.cooldownMinutes = count(value.cooldownMinutes, settings.cooldownMinutes);
    settings.triggerPressure = ratio(value.triggerPressure, settings.triggerPressure);
    return settings;
}

/** One noul question on the wire. */
export interface JevWireQuestion {
    type: "noul";
    instructions: string;
    criteria: { true: string; false: string };
}

/** POST body — nullish model/presetId are omitted so blanks never hit the wire. */
export interface JevWireRequest {
    model?: string;
    presetId?: string;
    state: string;
    questions: Record<string, JevWireQuestion>;
}

export interface JevWireAnswer {
    type: string;
    noul: number;
}

export interface JevWireUsage {
    input_tokens?: number;
    output_tokens?: number;
}

export interface JevWireResponse {
    model?: string;
    answers: Record<string, JevWireAnswer>;
    usage?: JevWireUsage;
}

/**
 * One candidate tool-call/result pair extracted from the live messages.
 * Incomplete pairs (missing or empty result) are listed but never pruned —
 * the strategy keeps them untouched, mirroring the Genius invariant that only
 * complete, unambiguous pairs may receive a non-keep decision.
 */
export interface JevBlock {
    /** The tool call id — also the scoring question key namespace. */
    blockId: string;
    /** Index of the assistant message carrying the call. */
    callMessageIndex: number;
    /** Index of the call inside that message's tool_calls array. */
    callIndex: number;
    /** Index of the tool message carrying the result (-1 when unpaired). */
    resultMessageIndex: number;
    /** `name({arguments})` rendering used for scoring. */
    callLine: string;
    /** Plain-text result (empty when absent or non-rewritable). */
    resultText: string;
    /** Characters the pair occupies (call line + separator + result). */
    contentCharacters: number;
    /** True when call and non-empty string result are both present. */
    complete: boolean;
}

/** Noul probabilities for one block: keep-the-call and keep-the-result. */
export interface JevScore {
    keepCall: number;
    keepResult: number;
}

export type JevAction = "keep" | "truncate" | "drop";

export interface JevDecision {
    blockId: string;
    action: JevAction;
    /** Truncation head (present only for the truncate action). */
    head?: string;
}
