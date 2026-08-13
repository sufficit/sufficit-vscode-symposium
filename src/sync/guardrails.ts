import { HubClient } from "./hubClient";
import { LocalMemory } from "../adapters/aiTools/localMemory";

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
export const MAX_GUARDRAIL_TEXT_LENGTH = 1000;
export const MAX_SESSION_GUARDRAILS = 50;

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
            expiresAtUtc?: string | number;
        }>
    )
        .filter(
            (r) =>
                r.type === GUARDRAIL_TYPE &&
                (r.sessionId ?? "") === sessionId &&
                (!r.expiresAtUtc || Date.parse(String(r.expiresAtUtc)) > Date.now()),
        )
        .sort(
            (a, b) =>
                Date.parse(String(a.createdAtUtc || "0")) -
                Date.parse(String(b.createdAtUtc || "0")),
        )
        .map((r) => ({
            id: String(r.id),
            text: r.summary || r.title || "",
            ts: String(r.createdAtUtc || ""),
        }))
        .filter((r) => r.text.length > 0)
        .slice(0, MAX_SESSION_GUARDRAILS);
}

/** Lists guardrails written to the per-user local fallback store. */
export async function fetchLocalSessionGuardrails(sessionId: string): Promise<GuardrailItem[]> {
    if (!sessionId) return [];
    const token = `symposium-session:${sessionId}`;
    const recs = await new LocalMemory().searchMemory({
        query: "",
        type: GUARDRAIL_TYPE,
        limit: 200,
    });
    return recs
        .filter((r) =>
            (r.tags ?? "")
                .split(",")
                .map((tag) => tag.trim())
                .includes(token),
        )
        .sort(
            (a, b) =>
                Date.parse(String(a.createdAtUtc || "0")) -
                Date.parse(String(b.createdAtUtc || "0")),
        )
        .map((r) => ({ id: r.id, text: r.summary || r.title || "", ts: r.createdAtUtc }))
        .filter((r) => r.text.length > 0)
        .slice(0, MAX_SESSION_GUARDRAILS);
}

/** Adds a guardrail for the session (privacy level internal, session-scoped). Returns the new id. */
export async function saveGuardrail(
    hub: HubClient,
    sessionId: string,
    text: string,
): Promise<string> {
    const t = text.trim();
    if (!t) {
        throw new Error("guardrail text is required");
    }
    if (t.length > MAX_GUARDRAIL_TEXT_LENGTH) {
        throw new Error(`guardrail text exceeds ${MAX_GUARDRAIL_TEXT_LENGTH} characters`);
    }
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

/** Soft-deletes one guardrail from the local fallback store. */
export async function removeLocalGuardrail(id: string): Promise<boolean> {
    if (!id) return false;
    const local = new LocalMemory();
    const [obs] = await local.getByIds([id]);
    if (!obs || obs.type !== GUARDRAIL_TYPE) return false;
    await local.save({ ...obs, expiresAtUtc: new Date(Date.now() - 1000).toISOString() });
    return true;
}

/** Soft-deletes all local fallback guardrails for a session. */
export async function clearLocalSessionGuardrails(sessionId: string): Promise<number> {
    const items = await fetchLocalSessionGuardrails(sessionId);
    let n = 0;
    for (const item of items) {
        try {
            if (await removeLocalGuardrail(item.id)) n++;
        } catch {
            /* best-effort */
        }
    }
    return n;
}
