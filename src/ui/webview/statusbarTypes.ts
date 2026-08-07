export interface CompressionUsage {
    savedChars?: number;
    originalChars?: number;
    compressedChars?: number;
    truncatedMessages?: number;
    removedMessages?: number;
    prunedToolCalls?: number;
    foldedToolResults?: number;
}

export interface UsageSnapshot {
    contextWindow?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    modelLabel?: string;
    model?: string;
    estimated?: boolean;
    providerKey?: string;
    providerType?: string;
    requestedModel?: string;
    attempts?: number;
    fallbackAttempts?: number;
    compression?: CompressionUsage;
    requestChars?: number;
    requestMessageCount?: number;
    requestToolCount?: number;
    durationMs?: number;
    ttfbMs?: number;
    firstDeltaMs?: number;
}

export interface StatusbarData extends Record<string, unknown> {
    backend?: string;
    backendName?: string;
    cwd?: string;
    permission?: string;
    reasoning?: string;
}

export interface LastTurn {
    costUsd?: number;
    durationMs?: number;
}
