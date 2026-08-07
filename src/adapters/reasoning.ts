/** Documented effort used by each backend when its picker does not override it. */
export const DEFAULT_REASONING_EFFORT: Record<string, string> = {
    claude: "medium",
    codex: "medium",
    copilot: "medium",
    openai: "medium",
};

/** The single five-level vocabulary shown by Symposium's effort picker. */
export const SYMPOSIUM_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Explicit Symposium → native effort maps. Unsupported Symposium levels are omitted. */
export const REASONING_MAPS = {
    claude: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    codex: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    copilot: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    openai: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
} as const;

/** Converts a configured/native value back to the canonical picker vocabulary. */
export function canonicalReasoning(map: Record<string, string>, native: string): string {
    if (!native || native === "default") {
        return "default";
    }
    const found = Object.entries(map).find(([, value]) => value === native);
    if (found) {
        return found[0];
    }
    // Preserve old settings that used Claude/Copilot's native max as the
    // highest Symposium slot, even though max is not a fifth UI label.
    if (native === "max" && map.xhigh) {
        return "xhigh";
    }
    return "default";
}

/** Maps a canonical picker value to the native effort sent to the backend. */
export function nativeReasoning(map: Record<string, string>, canonical: string): string {
    if (!canonical || canonical === "default") {
        return "default";
    }
    return map[canonical] ?? "default";
}
