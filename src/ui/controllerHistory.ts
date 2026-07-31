import type { AgentAdapter, SessionInfo } from "../adapters/types";

/** Loads a backend transcript and normalizes failures into render events. */
export async function loadControllerHistory(
    adapter: AgentAdapter,
    info: SessionInfo,
    emit: (message: unknown) => void,
): Promise<void> {
    if (!adapter.history) { return; }
    try {
        emit({ type: "history", messages: await adapter.history(info) });
    } catch (error) {
        emit({
            type: "event",
            event: { kind: "error", message: `failed to load history: ${error instanceof Error ? error.message : error}` },
        });
    }
}
