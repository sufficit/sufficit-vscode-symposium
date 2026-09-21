/**
 * Jev scorer over HTTP (port of the Genius plugin's JevScorer, sufficit mode
 * only): one POST per fitted batch with `{ model?, presetId?, state,
 * questions }` to the sufficit-ai jev endpoint. Bearer per request plus the
 * `X-Sufficit-Context-Id` header (the consuming context whose presets — own +
 * public shared — may be picked); one 401/403 forces a token refresh and
 * retries once. Strict response parsing: malformed protocol is never retried;
 * transport failures retry a bounded number of times. A failure in ANY batch
 * invalidates the whole proposal — no partial application.
 */

import type { JevBatch } from "./fitting";
import type { JevScore, JevWireRequest, JevWireResponse } from "./types";

/** Header the sufficit-ai jev endpoint requires (the consuming context id). */
const JEV_CONTEXT_ID_HEADER = "X-Sufficit-Context-Id";

interface JevScorerDeps {
    endpointUrl: string;
    /** The consuming context id (the token's `sub`). */
    contextId: string;
    /** Access token provider; one forced refresh on 401/403. */
    authToken: (forceRefresh?: boolean) => Promise<string | null>;
    presetId?: string;
    model?: string;
    /** Injectable for tests; defaults to global fetch. */
    fetchFn?: typeof fetch;
    maxConcurrentRequests?: number;
    maxRetries?: number;
    timeoutMs?: number;
    log?: (message: string) => void;
}

interface JevScorerResult {
    scores: Map<string, JevScore>;
    usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Decodes the `sub` claim of a JWT access token (base64url payload). Used as
 * the consuming context id; absent/invalid → undefined → jev stays off.
 */
export function contextIdFromToken(token: string): string | undefined {
    const parts = token.split(".");
    if (parts.length !== 3) {
        return undefined;
    }
    try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
            sub?: unknown;
        };
        return typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
    } catch {
        return undefined;
    }
}

function wireQuestion(question: {
    instructions: string;
    criteriaTrue: string;
    criteriaFalse: string;
}) {
    return {
        type: "noul" as const,
        instructions: question.instructions,
        criteria: { true: question.criteriaTrue, false: question.criteriaFalse },
    };
}

/**
 * Parses the answers of ONE batch into per-block scores. The answer keys are
 * the question names chosen at fitting, mapped back through the batch's own
 * questions — never by string-splitting the name. Each answer must be a noul
 * probability; a block's score needs BOTH halves. Throws on any protocol
 * deviation (never retried).
 */
function parseJevAnswers(batch: JevBatch, answers: Record<string, unknown>): Map<string, JevScore> {
    const byName = new Map(batch.questions.map((q) => [q.name, q]));
    const halves = new Map<string, { call?: number; result?: number }>();
    for (const [name, value] of Object.entries(answers)) {
        const question = byName.get(name);
        if (!question) {
            throw new Error(`jev scorer answered unknown question '${name}'`);
        }
        if (typeof value !== "object" || value === null) {
            throw new Error(`jev answer '${name}': expected an object`);
        }
        const answer = value as { type?: unknown; noul?: unknown };
        if (answer.type !== "noul") {
            throw new Error(`jev answer '${name}': expected a noul object`);
        }
        const noul = answer.noul;
        if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
            throw new Error(`jev answer '${name}': 'noul' missing or not a probability in [0,1]`);
        }
        const slot = halves.get(question.blockId) ?? {};
        const key = question.name.endsWith(".call") ? "call" : "result";
        if (slot[key] !== undefined) {
            throw new Error(`jev answer '${name}': duplicate`);
        }
        slot[key] = noul;
        halves.set(question.blockId, slot);
    }
    const scores = new Map<string, JevScore>();
    for (const blockId of new Set(batch.questions.map((q) => q.blockId))) {
        const slot = halves.get(blockId);
        if (slot?.call === undefined || slot.result === undefined) {
            throw new Error(`jev scorer did not answer both questions of ${blockId}`);
        }
        scores.set(blockId, { keepCall: slot.call, keepResult: slot.result });
    }
    return scores;
}

function parseUsage(raw: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }
    const usage = raw as { input_tokens?: unknown; output_tokens?: unknown };
    const read = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
    const inputTokens = read(usage.input_tokens);
    const outputTokens = read(usage.output_tokens);
    return inputTokens !== undefined || outputTokens !== undefined
        ? { inputTokens, outputTokens }
        : undefined;
}

async function sendOneBatch(
    batch: JevBatch,
    state: string,
    deps: JevScorerDeps,
    gate: { acquire(): Promise<void>; release(): void },
    refreshed: { value: boolean },
): Promise<{
    scores: Map<string, JevScore>;
    usage?: { inputTokens?: number; outputTokens?: number };
}> {
    const maxRetries = deps.maxRetries ?? 2;
    const timeoutMs = deps.timeoutMs ?? 30_000;
    const fetchFn = deps.fetchFn ?? fetch;
    for (let attempt = 0; ; attempt++) {
        const token = await deps.authToken(refreshed.value);
        if (!token) {
            throw new Error("jev scorer: no Sufficit access token available");
        }
        await gate.acquire();
        let response: Response;
        try {
            const body: JevWireRequest = {
                ...(deps.model ? { model: deps.model } : {}),
                ...(deps.presetId ? { presetId: deps.presetId } : {}),
                state,
                questions: Object.fromEntries(
                    batch.questions.map((q) => [q.name, wireQuestion(q)]),
                ),
            };
            response = await fetchFn(deps.endpointUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${token}`,
                    [JEV_CONTEXT_ID_HEADER]: deps.contextId,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            gate.release();
            if (attempt >= maxRetries) {
                throw new Error(
                    `jev scorer unreachable after ${attempt + 1} attempts: ${String(error)}`,
                );
            }
            await delay(400 * (attempt + 1));
            continue;
        }
        gate.release();
        if (response.status === 401 || response.status === 403) {
            if (!refreshed.value) {
                refreshed.value = true; // one forced refresh, then one retry
                continue;
            }
            throw new Error(
                `jev scorer rejected the credential (${response.status}); not retrying`,
            );
        }
        if (response.status < 200 || response.status >= 300) {
            if (attempt >= maxRetries) {
                throw new Error(
                    `jev scorer still HTTP ${response.status} after ${attempt + 1} attempts`,
                );
            }
            await delay(400 * (attempt + 1));
            continue;
        }
        const json = (await response.json().catch(() => {
            throw new Error("jev scorer response is not valid JSON");
        })) as JevWireResponse;
        if (
            typeof json !== "object" ||
            json === null ||
            typeof json.answers !== "object" ||
            json.answers === null
        ) {
            throw new Error("jev scorer response must be an object with an 'answers' object");
        }
        return {
            scores: parseJevAnswers(batch, json.answers as Record<string, unknown>),
            usage: parseUsage(json.usage),
        };
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scores every fitted batch (bounded concurrency, shared token refresh).
 * Returns per-block scores plus summed usage; rejects when any batch fails.
 */
export async function scoreJevBatches(
    fit: { state: string; batches: JevBatch[] },
    deps: JevScorerDeps,
): Promise<JevScorerResult> {
    const limit = Math.max(1, Math.min(8, deps.maxConcurrentRequests ?? 2));
    let active = 0;
    const waiting: (() => void)[] = [];
    const gate = {
        acquire(): Promise<void> {
            if (active < limit) {
                active++;
                return Promise.resolve();
            }
            return new Promise((resolve) => waiting.push(resolve));
        },
        release(): void {
            active--;
            const next = waiting.shift();
            if (next) {
                active++;
                next();
            }
        },
    };
    const refreshed = { value: false };
    const results = await Promise.all(
        fit.batches.map((batch) => sendOneBatch(batch, fit.state, deps, gate, refreshed)),
    );
    const scores = new Map<string, JevScore>();
    let inputTokens = 0;
    let outputTokens = 0;
    let seenUsage = false;
    for (const result of results) {
        for (const [blockId, score] of result.scores) {
            if (scores.has(blockId)) {
                throw new Error(`jev scorer returned duplicate scores for ${blockId}`);
            }
            scores.set(blockId, score);
        }
        if (result.usage) {
            seenUsage = true;
            inputTokens += result.usage.inputTokens ?? 0;
            outputTokens += result.usage.outputTokens ?? 0;
        }
    }
    return {
        scores,
        usage: seenUsage ? { inputTokens, outputTokens } : undefined,
    };
}
