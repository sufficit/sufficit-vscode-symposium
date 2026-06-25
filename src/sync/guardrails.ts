import { HubClient } from "./hubClient";
import { sessionTag } from "./tasks";

/**
 * Guardrails are "absolute rules" for a Symposium chat session, stored as
 * Sufficit-memory observations (type "guardrail") bound to the session via the
 * same symposium-session:<id> tag as tasks, and injected into EVERY outbound
 * message so the agent cannot drift from or ignore them.
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

const hasTag = (tags: unknown, tag: string): boolean =>
    String(tags ?? "").split(",").map((t) => t.trim()).includes(tag);

/** Lists a session's guardrails, oldest first (definition order). */
export async function fetchSessionGuardrails(hub: HubClient, sessionId: string): Promise<GuardrailItem[]> {
    if (!hub.configured() || !sessionId) { return []; }
    const tag = sessionTag(sessionId);
    // Mirror fetchSessionTasks: the server-side `type` filter on /api/memory/search
    // is unreliable (same reason tasks pulls untyped and filters locally), which is
    // why the typed query left the Guardrails panel empty on reopen. Pull recent
    // records and filter by type + session tag locally. Limit 200 keeps a margin so
    // the (few) guardrails aren't diluted out by the many task-checkpoints.
    const recs = await hub.searchMemory({ limit: 200 });
    return (recs as Array<{ type: string; tags?: string | string[]; id: unknown; summary?: string; title?: string; createdAtUtc?: string | number }>)
        .filter((r) => r.type === GUARDRAIL_TYPE && hasTag(r.tags, tag))
        .sort((a, b) => Date.parse(String(a.createdAtUtc || "0")) - Date.parse(String(b.createdAtUtc || "0")))
        .map((r) => ({ id: String(r.id), text: r.summary || r.title || "", ts: String(r.createdAtUtc || "") }));
}

/** Adds a guardrail for the session. Returns the new id. */
export async function saveGuardrail(hub: HubClient, sessionId: string, text: string): Promise<string> {
    const t = text.trim();
    return hub.save({
        type: GUARDRAIL_TYPE,
        title: t.slice(0, 60),
        summary: t,
        tags: `${GUARDRAIL_TYPE},${sessionTag(sessionId)}`,
    });
}

/** Removes one guardrail (soft-delete via past expiry, mirroring tasks). */
export async function removeGuardrail(hub: HubClient, id: string): Promise<boolean> {
    if (!hub.configured() || !id) { return false; }
    const [obs] = await hub.getByIds([id]);
    if (!obs) { return false; }
    await hub.save({ ...obs, expiresAtUtc: new Date(Date.now() - 1000).toISOString() });
    return true;
}

/** Clears all guardrails for a session. Returns how many were removed. */
export async function clearSessionGuardrails(hub: HubClient, sessionId: string): Promise<number> {
    const items = await fetchSessionGuardrails(hub, sessionId);
    let n = 0;
    for (const g of items) {
        try { if (await removeGuardrail(hub, g.id)) { n++; } } catch { /* best-effort */ }
    }
    return n;
}
