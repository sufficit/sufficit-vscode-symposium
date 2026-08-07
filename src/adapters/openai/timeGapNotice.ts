import * as ledger from "../../ledger";
import { OpenAIAdapterConfig } from "./types";

const TIME_GAP_THRESHOLDS_MS: Record<string, number> = {
    "5m": 5 * 60_000,
    "30m": 30 * 60_000,
    "2h": 2 * 60 * 60_000,
    "12h": 12 * 60 * 60_000,
};

function formatGap(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    if (totalMinutes < 60) {
        return `${Math.max(1, totalMinutes)}m`;
    }
    const totalHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (totalHours < 24) {
        return minutes ? `${totalHours}h${minutes}m` : `${totalHours}h`;
    }
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours ? `${days}d${hours}h` : `${days}d`;
}

export function buildTimeGapNotice(
    cfg: OpenAIAdapterConfig,
    sessionId: string,
): string | undefined {
    const setting = cfg.timeGapNotice ?? "5m";
    const thresholdMs = TIME_GAP_THRESHOLDS_MS[setting];
    if (!thresholdMs) {
        return undefined;
    }
    const lastAt = ledger.lastMessageAtMs(sessionId);
    if (lastAt == null) {
        return undefined;
    }
    const gapMs = Date.now() - lastAt;
    if (gapMs < thresholdMs) {
        return undefined;
    }
    return (
        `[Time gap: ~${formatGap(gapMs)} since your last message in this conversation — ` +
        "you may be resuming this on a different day/session; don't assume very recent context is still fresh.]"
    );
}
