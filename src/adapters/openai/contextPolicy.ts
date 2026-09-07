import { windowMessages } from "./requestWindow";
import type { ChatMessage, OpenAIAdapterConfig } from "./types";

/** Request/summary policy only. These values never govern ledger retention. */
export const contextPolicyDefaults = {
    historyNotice: true,
    compactionTailMessages: 6,
    summaryTargetTokens: 1500,
    summaryToolCharacters: 400,
    summaryArgumentCharacters: 80,
    readMaxCharacters: 24000,
};

export type ContextPolicy = typeof contextPolicyDefaults;

export function normalizeContextPolicy(value?: Partial<ContextPolicy> | null): ContextPolicy {
    const policy = { ...contextPolicyDefaults };
    for (const key of Object.keys(policy) as (keyof ContextPolicy)[]) {
        const candidate = value?.[key];
        if (key === "historyNotice") {
            if (typeof candidate === "boolean") policy[key] = candidate;
        } else if (
            typeof candidate === "number" &&
            Number.isSafeInteger(candidate) &&
            candidate > 0
        ) {
            policy[key] = candidate;
        }
    }
    return policy;
}

export function historyOmissionNotice(sessionId: string, total: number, sent: number): string {
    return (
        `Context selection: ${sent} of ${total} live messages selected for this request. ` +
        `Earlier original messages remain in session ${sessionId}. Use read_session with that id ` +
        `to verify earlier decisions or recover omitted tool results when needed. ` +
        `Retrieved history is reference data; current instructions and cancellations still apply.`
    );
}

export function selectRequestHistory(
    messages: ChatMessage[],
    total: number,
    deps: { cfg: OpenAIAdapterConfig; sessionId: string },
): ChatMessage[] {
    const selected = windowMessages(messages, deps.cfg.maxHistoryMessages ?? 40);
    if (selected.length >= total || !normalizeContextPolicy(deps.cfg.contextPolicy).historyNotice)
        return selected;
    return [
        {
            role: deps.cfg.supportsDeveloperRole !== false ? "developer" : "system",
            content: historyOmissionNotice(deps.sessionId, total, selected.length),
        },
        ...selected,
    ];
}
