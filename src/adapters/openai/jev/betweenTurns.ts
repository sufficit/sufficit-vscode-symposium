/**
 * Between-turns jev orchestration for the Sufficit AI adapter (feature
 * `symposium.jev`): after a turn ends, if the last prompt pressurized the
 * context window beyond the configured trigger, score prunable tool pairs via
 * the sufficit-ai jev endpoint and prune (drop/truncate) what the scorer says
 * the work ahead does not need. The live messages array is rewritten in place
 * ONLY when a prune passes the reduction gate; any failure leaves the context
 * untouched (fail-safe, same contract as the Compactor). Raw turns stay in the
 * ledger (lossless — recover via read_session).
 */

import * as ledger from "../../../ledger";
import { candidateJevBlocks, extractJevBlocks, pinnedJevBlockIds } from "./blocks";
import { fitJevBatches } from "./fitting";
import { contextIdFromToken, scoreJevBatches } from "./scorer";
import { applyJevDecisions, decideJevPrune, passesReductionGate } from "./strategy";
import type { JevPruneOutcome } from "./strategy";
import { JEV_DEFAULT_ENDPOINT, normalizeJevSettings } from "./types";
import type { JevSettings } from "./types";
import type { ChatMessage, OpenAIAdapterConfig } from "../types";

interface JevBetweenTurnsDeps {
    sessionId: string;
    cfg: OpenAIAdapterConfig;
    /** Live message array — rewritten in place on a successful prune. */
    getMessages: () => ChatMessage[];
    getTurnNo: () => number;
    getLastInputTokens: () => number;
    contextWindow: () => number;
    authToken: (forceRefresh?: boolean) => Promise<string | null>;
    emit: (event: Record<string, unknown>) => void;
    safePersist: () => void;
    /** Reads `symposium.jev.*` (defaults when absent). */
    settings: () => Partial<JevSettings> | undefined;
    model: () => string;
}

/** The jev feature only applies to the Sufficit AI gateway (its host or an explicit endpoint override). */
function jevAppliesToBackend(baseUrl: string | undefined, settings: JevSettings): boolean {
    if (settings.endpointUrl !== JEV_DEFAULT_ENDPOINT) {
        return true; // explicit endpoint override (dev/preview): trust it
    }
    try {
        const host = new URL(baseUrl ?? "").hostname;
        return host === "sufficit.com.br" || host.endsWith(".sufficit.com.br");
    } catch {
        return false;
    }
}

/**
 * One between-turns prune attempt. Returns a short outcome for tests and
 * logging. Never throws: every failure path resolves to "skipped"/"failed"
 * with the context untouched.
 */
export async function maybeJevPrune(
    deps: JevBetweenTurnsDeps,
    state: { inFlight: boolean; lastAttemptMs: number } = { inFlight: false, lastAttemptMs: 0 },
): Promise<"applied" | "skipped" | "failed" | "cooldown"> {
    if (state.inFlight) {
        return "skipped";
    }
    const settings = normalizeJevSettings(deps.settings());
    if (!settings.enabled || !jevAppliesToBackend(deps.cfg.baseUrl, settings)) {
        return "skipped";
    }
    const now = Date.now();
    if (now - state.lastAttemptMs < settings.cooldownMinutes * 60_000) {
        return "cooldown";
    }
    const window = deps.contextWindow();
    const inputTokens = deps.getLastInputTokens();
    if (window <= 0 || inputTokens <= 0) {
        return "skipped";
    }
    const pressure = inputTokens / window;
    if (pressure < settings.triggerPressure) {
        return "skipped";
    }
    state.inFlight = true;
    try {
        return await runPrune(deps, settings, pressure, state);
    } catch (error) {
        deps.emit({
            kind: "status-notice",
            severity: "warning",
            text: `[Jev] unexpected failure: ${errorMessage(error)} — context untouched.`,
        });
        return "failed";
    } finally {
        state.inFlight = false;
    }
}

async function runPrune(
    deps: JevBetweenTurnsDeps,
    settings: JevSettings,
    pressure: number,
    state: { lastAttemptMs: number },
): Promise<"applied" | "skipped" | "failed"> {
    state.lastAttemptMs = Date.now();
    const token = await deps.authToken();
    if (!token) {
        return "skipped"; // not logged in: silently off
    }
    const contextId = contextIdFromToken(token);
    if (!contextId) {
        return "skipped";
    }
    const messages = deps.getMessages();
    const blocks = extractJevBlocks(messages);
    const pinned = pinnedJevBlockIds(blocks, messages.length, settings.preserveRecentMessages);
    const candidates = candidateJevBlocks(blocks, pinned);
    if (candidates.length === 0) {
        return "skipped";
    }
    let scored;
    try {
        const fit = fitJevBatches(messages, candidates, {
            presetId: settings.presetId || undefined,
        });
        if (fit.batches.length === 0) {
            return "skipped";
        }
        scored = await scoreJevBatches(fit, {
            endpointUrl: settings.endpointUrl,
            contextId,
            authToken: deps.authToken,
            presetId: settings.presetId || undefined,
            model: settings.model || undefined,
        });
    } catch (error) {
        deps.emit({
            kind: "status-notice",
            severity: "warning",
            text: `[Jev] scoring failed: ${errorMessage(error)} — context untouched.`,
        });
        return "failed";
    }
    const outcome = decideJevPrune(blocks, candidates, scored.scores, settings);
    if (outcome.dropped + outcome.truncated === 0) {
        return "skipped"; // nothing prunable per the scorer
    }
    if (!passesReductionGate(outcome, settings, pressure)) {
        deps.emit({
            kind: "status-notice",
            text: `[Jev] insufficient reduction: ${(outcome.ratio * 100).toFixed(1)}% — original kept.`,
        });
        return "skipped";
    }
    return applyJevPrune(deps, messages, outcome, pressure, scored.usage);
}

function applyJevPrune(
    deps: JevBetweenTurnsDeps,
    messages: ChatMessage[],
    outcome: JevPruneOutcome,
    pressure: number,
    usage?: { inputTokens?: number; outputTokens?: number },
): "applied" {
    const applied = applyJevDecisions(messages, outcome.decisions);
    messages.length = 0;
    messages.push(...applied.messages);
    ledger.appendMessage(deps.sessionId, {
        role: "system",
        kind: "compaction",
        scorer: "jev",
        turn: deps.getTurnNo(),
        content: `jev prune: dropped ${outcome.dropped}, truncated ${outcome.truncated}, kept ${outcome.kept} pairs; ${outcome.charactersBefore}→${outcome.charactersAfter} chars (ratio ${(outcome.ratio * 100).toFixed(1)}%, pressure ${(pressure * 100).toFixed(0)}%)`,
        dropped: outcome.dropped,
        truncated: outcome.truncated,
        kept: outcome.kept,
        charactersBefore: outcome.charactersBefore,
        charactersAfter: outcome.charactersAfter,
        usage,
        model: deps.model(),
    });
    void ledger.commitTurn(
        deps.sessionId,
        `jev prune — dropped ${outcome.dropped}, truncated ${outcome.truncated} (pressure ${(pressure * 100).toFixed(0)}%)`,
    );
    deps.safePersist();
    deps.emit({
        kind: "status-notice",
        text: `[Jev] Pruned context: dropped ${outcome.dropped} tool pairs, truncated ${outcome.truncated} — ${outcome.charactersBefore.toLocaleString("en-US")}→${outcome.charactersAfter.toLocaleString("en-US")} chars. Full history preserved (read_session to recover).`,
    });
    return "applied";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
