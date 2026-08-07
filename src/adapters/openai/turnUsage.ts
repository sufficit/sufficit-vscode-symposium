import { ApiUsage } from "./types";
import type { TurnRunnerDeps } from "./turnRunnerDeps";

export function emitTurnUsage(d: TurnRunnerDeps, usage: ApiUsage): void {
    if (!(usage.inputTokens || usage.outputTokens)) {
        return;
    }
    d.setLastInputTokens(usage.inputTokens || d.getLastInputTokens());
    d.emit({
        kind: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        cacheRead: usage.cacheRead,
        contextWindow: d.contextWindow(),
        model: usage.model,
        modelLabel: usage.model ? d.label(usage.model) : undefined,
        providerKey: usage.providerKey,
        providerType: usage.providerType,
        requestedModel: usage.requestedModel,
        attempts: usage.attempts,
        fallbackAttempts: usage.fallbackAttempts,
        compression: usage.compression,
        durationMs: usage.durationMs,
        ttfbMs: usage.ttfbMs,
        firstDeltaMs: usage.firstDeltaMs,
    });
}
