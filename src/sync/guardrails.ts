import { HubClient } from "./hubClient";

/**
 * Guardrails are "absolute rules" for a Symposium chat session, stored as
 * Sufficit-memory observations (type "guardrail") scoped to the session via the
 * native `sessionId` field (privacy level "internal", so they never leak outside
 * the session that created them). They are injected into EVERY outbound message
 * so the agent cannot drift from or ignore them.
 *
 * Ownership: the AGENT adds them (`add_guardrail`) to lock in a hard constraint
 * the user gave it or a commitment it makes, and can clear them all on request
 * (`clear_guardrails`). The USER can also remove/clear from the UI. The panel
 * only appears once at least one rule is set.
 */

export const GUARDRAIL_TYPE = "guardrail";

export interface GuardrailItem {
    id: string;
    text: string;
    ts?: string;
}

/** Lists a session's guardrails, oldest first (definition order). */
export async function fetchSessionGuardrails(
    hub: HubClient,
    sessionId: string,
): Promise<GuardrailItem[]> {
    if (!hub.configured() || !sessionId) {
        return [];
    }
    // Search is scoped to the session by the native sessionId field on the
    // server (EFMemoryService filters by session_id). Pull recent records and
    // keep only the guardrail type for this session. Limit 200 keeps a margin so
    // the (few) guardrails aren't diluted out by the many task-checkpoints.
    const recs = await hub.searchMemory({ limit: 200, sessionId });
    return (
        recs as Array<{
            type: string;
            sessionId?: string;
            id: unknown;
            summary?: string;
            title?: string;
            createdAtUtc?: string | number;
        }>
    )
        .filter((r) => r.type === GUARDRAIL_TYPE && (r.sessionId ?? "") === sessionId)
        .sort(
            (a, b) =>
                Date.parse(String(a.createdAtUtc || "0")) -
                Date.parse(String(b.createdAtUtc || "0")),
        )
        .map((r) => ({
            id: String(r.id),
            text: r.summary || r.title || "",
            ts: String(r.createdAtUtc || ""),
        }));
}

/** Adds a guardrail for the session (privacy level internal, session-scoped). Returns the new id. */
export async function saveGuardrail(
    hub: HubClient,
    sessionId: string,
    text: string,
): Promise<string> {
    const t = text.trim();
    return hub.save({
        type: GUARDRAIL_TYPE,
        title: t.slice(0, 60),
        summary: t,
        sessionId,
        privacyLevel: "internal",
    });
}

/** Removes one guardrail (soft-delete via past expiry, mirroring tasks). */
export async function removeGuardrail(hub: HubClient, id: string): Promise<boolean> {
    if (!hub.configured() || !id) {
        return false;
    }
    const [obs] = await hub.getByIds([id]);
    if (!obs) {
        return false;
    }
    await hub.save({ ...obs, expiresAtUtc: new Date(Date.now() - 1000).toISOString() });
    return true;
}

/** Clears all guardrails for a session. Returns how many were removed. */
export async function clearSessionGuardrails(hub: HubClient, sessionId: string): Promise<number> {
    const items = await fetchSessionGuardrails(hub, sessionId);
    let n = 0;
    for (const g of items) {
        try {
            if (await removeGuardrail(hub, g.id)) {
                n++;
            }
        } catch {
            /* best-effort */
        }
    }
    return n;
}
