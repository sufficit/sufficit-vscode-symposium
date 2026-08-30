import { HubClient } from "../sync/hubClient";
import {
    clearLocalSessionGuardrails,
    clearSessionGuardrails,
    fetchLocalSessionGuardrails,
    fetchSessionGuardrails,
    removeGuardrail,
    removeLocalGuardrail,
} from "../sync/guardrails";

export interface SurfaceGuardrail {
    id: string;
    text: string;
}

/** Reads the same shared/local guardrail source used by the controller. */
export async function loadSurfaceGuardrails(
    hub: HubClient,
    sessionId: string,
    previous: SurfaceGuardrail[] = [],
): Promise<SurfaceGuardrail[]> {
    if (!sessionId) return [];
    try {
        const items = hub.configured()
            ? await fetchSessionGuardrails(hub, sessionId)
            : await fetchLocalSessionGuardrails(sessionId);
        return items.map(({ id, text }) => ({ id, text }));
    } catch {
        try {
            const local = (await fetchLocalSessionGuardrails(sessionId)).map(({ id, text }) => ({
                id,
                text,
            }));
            return local.length > 0 || previous.length === 0 ? local : previous;
        } catch {
            return previous;
        }
    }
}

/** Removes a guardrail from the shared store, falling back to local storage. */
export async function removeSurfaceGuardrail(hub: HubClient, id: string): Promise<void> {
    let removed = false;
    if (hub.configured()) {
        try {
            removed = await removeGuardrail(hub, id);
        } catch {
            /* fall through to local fallback */
        }
    }
    if (!removed) await removeLocalGuardrail(id);
}

/** Clears a session's guardrails from the shared store, falling back locally. */
export async function clearSurfaceGuardrails(hub: HubClient, sessionId: string): Promise<void> {
    if (hub.configured()) {
        try {
            await clearSessionGuardrails(hub, sessionId);
            return;
        } catch {
            /* fall through to local fallback */
        }
    }
    await clearLocalSessionGuardrails(sessionId);
}
