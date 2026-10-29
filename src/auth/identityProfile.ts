import { parseOAuthJson } from "./oauthHttp";
import { Discovery, SufficitProfile } from "./identityTypes";

/**
 * Forced userinfo fetch used by every getProfile(true) caller (issue #40,
 * phase 8). Returns undefined on a transient HTTP failure so callers keep the
 * cached profile; transport/parse errors propagate to the caller's handler.
 */
export async function fetchSufficitProfile(
    issuer: string,
    token: string,
    discovery: () => Promise<Discovery>,
): Promise<SufficitProfile | undefined> {
    const disco = await discovery();
    const res = await fetch(disco.userinfo_endpoint ?? `${issuer}/connect/userinfo`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        return undefined;
    }
    const j = await parseOAuthJson<{
        sub?: string;
        name?: string;
        preferred_username?: string;
        email?: string;
        picture?: string;
    }>(res, "Sufficit userinfo endpoint");
    // Avatar comes from the Sufficit contact endpoint keyed by the user id.
    const picture = j.sub
        ? `https://endpoints.sufficit.com.br/contact/avatar?contextid=${encodeURIComponent(j.sub)}`
        : j.picture;
    return {
        sub: j.sub ?? "",
        name: j.name ?? j.preferred_username,
        email: j.email,
        picture,
    };
}

/**
 * Coalesces forced profile fetches into one in-flight request and collapses
 * equivalent change notifications into a single published transition
 * (issue #40, phase 8: one stable state transition per auth change).
 */
export class ProfileChangeGate {
    private inFlight?: Promise<SufficitProfile | undefined>;
    private notifyScheduled = false;

    constructor(private readonly emitter: { fire(): void }) {}

    run(task: () => Promise<SufficitProfile | undefined>): Promise<SufficitProfile | undefined> {
        if (!this.inFlight) {
            this.inFlight = (async () => {
                try {
                    return await task();
                } finally {
                    this.inFlight = undefined;
                }
            })();
        }
        return this.inFlight;
    }

    notify(): void {
        if (this.notifyScheduled) {
            return;
        }
        this.notifyScheduled = true;
        queueMicrotask(() => {
            this.notifyScheduled = false;
            this.emitter.fire();
        });
    }
}
