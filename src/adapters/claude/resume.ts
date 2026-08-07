const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SUBAGENT_SESSION = new RegExp(`^(${UUID})/subagents/[^/]+$`, "i");

/**
 * Subagent transcript ids are Symposium-only tree keys, not Claude sessions.
 * Claude records every subagent line with the parent conversation's UUID and
 * `claude --resume` accepts only that UUID (or a named top-level session).
 */
export function claudeResumeSessionId(sessionId: string | undefined): string | undefined {
    if (!sessionId) {
        return undefined;
    }
    return SUBAGENT_SESSION.exec(sessionId)?.[1] ?? sessionId;
}
