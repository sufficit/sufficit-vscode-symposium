/**
 * Genius tool-call summaries.
 * The heuristics now live in the shared adapters/toolSummary module; this
 * file remains as the thin Genius-facing facade (tool name + JSON args).
 */
import { toolSummary } from "../toolSummary";

/** A display-only summary; the unmodified arguments remain in the expanded row. */
export function geniusToolSummary(name: string, input: string): string | undefined {
    return toolSummary(name, input);
}
