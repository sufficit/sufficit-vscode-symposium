import * as vscode from "vscode";

/**
 * HTTP client for the sufficit-ai memory + vault REST API (the sync hub).
 *
 * Endpoints mirror the MCP tools:
 *   POST /api/memory/save      upsert (id present → update, absent → create)
 *   POST /api/memory/search    compact records by type
 *   POST /api/memory/observations  full docs by ids
 *   GET  /api/memory/health    liveness (health-gate)
 *   GET  /api/vault/secrets/resolve?reference=  secret value (410 if expired)
 *
 * Configured via settings: symposium.hub.url, symposium.hub.token,
 * symposium.hub.contextId (optional tenant boundary).
 */

export interface CompactRecord {
    id: string;
    type: string;
    title: string;
    summary: string;
    tags?: string;
    /** Caller session id (when the observation was scoped to a session). */
    sessionId?: string;
}

export interface Observation {
    id?: string;
    type: string;
    title: string;
    summary: string;
    payload?: string;
    tags?: string;
    /** Caller session id; scopes the observation to a single chat session. */
    sessionId?: string;
    /** Privacy level: "public" | "tenant" | "private" | "internal". Defaults to tenant. */
    privacyLevel?: string;
    /** ISO-8601 expiry; set in the past to soft-delete on the next save (upsert). */
    expiresAtUtc?: string;
}

export interface SaveResponse {
    success: boolean;
    data?: { id: string; createdAtUtc: string };
}

export interface SymposiumJoinResult {
    ok: boolean;
    tailnetJoinKey?: string;
    tailnetLoginServer?: string;
    hostnamePrefix?: string;
    magicDnsBaseDomain?: string;
}

export interface SymposiumRemoteUrlResult {
    online: boolean;
    hostname?: string;
    bridgePort?: number;
}

export interface RelayRegisterResult {
    ok: boolean;
    /** WebSocket URL of the relay gateway (e.g. wss://ai.sufficit.com.br/symposium?ws=relay). */
    relayWsUrl?: string;
    /** Public URL prefix containing the gateway's owner-scoped relay machine ID. */
    publicUrlPrefix?: string;
}

/**
 * Optional provider of a Sufficit Identity access token (from the logged-in
 * session). When set and it returns a token, the hub uses it as the Bearer
 * instead of the static symposium.hub.token. Set at activation.
 */
let loginTokenProvider: (() => Promise<string | null>) | undefined;
export function setHubTokenProvider(fn: () => Promise<string | null>): void {
    loginTokenProvider = fn;
}

/** Returns the Sufficit login token from the registered provider, or null. */
export async function getHubLoginToken(): Promise<string | null> {
    if (!loginTokenProvider) {
        return null;
    }
    try {
        return await loginTokenProvider();
    } catch {
        return null;
    }
}

export class HubClient {
    private base(): string {
        const explicit = vscode.workspace
            .getConfiguration("symposium.hub")
            .get<string>("url", "")
            .replace(/\/+$/, "");
        if (explicit) {
            return explicit;
        }
        // Derive hub URL from the OpenAI base URL (same Sufficit AI gateway host).
        // Users who configure openai.baseUrl get auto-sync without a separate hub.url.
        const openaiBase = vscode.workspace
            .getConfiguration("symposium.openai")
            .get<string>("baseUrl", "");
        if (!openaiBase) {
            return "";
        }
        try {
            return new URL(openaiBase).origin;
        } catch {
            return "";
        }
    }

    private token(): string {
        const hubToken = vscode.workspace
            .getConfiguration("symposium.hub")
            .get<string>("token", "");
        if (hubToken) {
            return hubToken;
        }
        // Reuse the Sufficit AI / OpenAI key: the same service key that
        // authenticates the chat backend also satisfies the memory + vault REST
        // API, so the user configures one key instead of two. (The chat path uses
        // openai.apiKey; without this, memory fell back to the login identity
        // token, which the memory API rejects with 401.)
        return vscode.workspace.getConfiguration("symposium.openai").get<string>("apiKey", "");
    }

    private contextId(): string {
        return vscode.workspace.getConfiguration("symposium.hub").get<string>("contextId", "");
    }

    private source(): string {
        return vscode.workspace
            .getConfiguration("symposium.hub")
            .get<string>("source", "symposium");
    }

    /** True when a hub URL is configured. */
    configured(): boolean {
        return this.base().length > 0;
    }

    private async headers(): Promise<Record<string, string>> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        // Prefer the static hub token (the AIUser-policy service token the
        // memory/vault API accepts); fall back to the logged-in identity token
        // only when no static token is configured. The identity token often
        // lacks the AI claims the hub requires, so preferring it made every save
        // 401 for logged-in users. Mirrors the OpenAI adapter's auth order.
        let token = this.token();
        if (!token && loginTokenProvider) {
            token = (await loginTokenProvider().catch(() => null)) ?? "";
        }
        if (token) {
            h["Authorization"] = `Bearer ${token}`;
        }
        const ctx = this.contextId();
        if (ctx) {
            h["X-MEMORY-CONTEXT-ID"] = ctx;
        }
        h["X-MEMORY-SOURCE-ID"] = this.source() || "symposium";
        return h;
    }

    /** Liveness probe for the health-gate. Returns false on any failure. */
    async health(): Promise<boolean> {
        if (!this.configured()) {
            return false;
        }
        try {
            const res = await fetch(`${this.base()}/api/memory/health`, {
                headers: await this.headers(),
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    /** Lists compact records of one type (empty query → recent, up to limit). */
    async searchByType(type: string, limit = 100): Promise<CompactRecord[]> {
        return this.searchMemory({ type, limit });
    }

    /** Free-form memory search (query/type/limit). Returns compact records. */
    async searchMemory(params: {
        query?: string;
        type?: string;
        limit?: number;
        sessionId?: string;
    }): Promise<CompactRecord[]> {
        const res = await fetch(`${this.base()}/api/memory/search`, {
            method: "POST",
            headers: await this.headers(),
            body: JSON.stringify({ limit: 20, ...params }),
        });
        if (!res.ok) {
            throw new Error(`memory search failed: ${res.status}`);
        }
        return (await res.json()) as CompactRecord[];
    }

    /** Web search via the sufficit-ai gateway (SearXNG-backed). Returns raw JSON. */
    async webSearch(query: string, limit = 8): Promise<unknown> {
        const res = await fetch(`${this.base()}/api/ai/websearch`, {
            method: "POST",
            headers: await this.headers(),
            body: JSON.stringify({ query, limit }),
        });
        if (!res.ok) {
            throw new Error(`web search failed: ${res.status}`);
        }
        return await res.json();
    }

    /** Fetches full observations (with payload) by id. */
    async getByIds(ids: string[]): Promise<Observation[]> {
        if (ids.length === 0) {
            return [];
        }
        const res = await fetch(`${this.base()}/api/memory/observations`, {
            method: "POST",
            headers: await this.headers(),
            body: JSON.stringify({ ids }),
        });
        if (!res.ok) {
            throw new Error(`getByIds failed: ${res.status}`);
        }
        return (await res.json()) as Observation[];
    }

    /** Upserts an observation (id present → update, absent → create). Returns new id. */
    async save(observation: Observation): Promise<string> {
        const res = await fetch(`${this.base()}/api/memory/save`, {
            method: "POST",
            headers: await this.headers(),
            body: JSON.stringify(observation),
        });
        if (!res.ok) {
            throw new Error(`save failed: ${res.status}`);
        }
        const body = (await res.json()) as SaveResponse;
        return body.data?.id ?? observation.id ?? "";
    }

    /**
     * Resolves a vault secret for runtime injection. Returns null when unknown,
     * expired (410), or the hub is unreachable.
     */
    async resolveSecret(reference: string): Promise<string | null> {
        if (!this.configured() || !reference) {
            return null;
        }
        try {
            const url = `${this.base()}/api/vault/secrets/resolve?reference=${encodeURIComponent(reference)}`;
            const res = await fetch(url, { headers: await this.headers() });
            if (!res.ok) {
                return null; // 404 unknown / 410 expired / 401 etc.
            }
            const body = (await res.json()) as { value?: string };
            return body.value ?? null;
        } catch {
            return null;
        }
    }

    /** Mints a tailnet preauthkey for this Symposium install's remote-bridge node. */
    async joinSymposiumTailnet(): Promise<SymposiumJoinResult | null> {
        if (!this.configured()) {
            return null;
        }
        try {
            const res = await fetch(`${this.base()}/api/symposium/join`, {
                method: "POST",
                headers: await this.headers(),
            });
            if (!res.ok) {
                return null;
            }
            return (await res.json()) as SymposiumJoinResult;
        } catch {
            return null;
        }
    }

    /** Resolves whichever machine currently has this user's Symposium remote bridge active. */
    async resolveSymposiumRemoteUrl(): Promise<SymposiumRemoteUrlResult | null> {
        if (!this.configured()) {
            return null;
        }
        try {
            const res = await fetch(`${this.base()}/api/symposium/remote-url`, {
                headers: await this.headers(),
            });
            if (!res.ok) {
                return null;
            }
            return (await res.json()) as SymposiumRemoteUrlResult;
        } catch {
            return null;
        }
    }

    /**
     * Registers this machine for the Sufficit relay tunnel. Returns the WS URL
     * to connect to and the public URL prefix, or null when the gateway doesn't
     * support relaying (relay is a newer feature than tailnet join).
     */
    async registerRelay(machineId: string): Promise<RelayRegisterResult | null> {
        if (!this.configured()) {
            return null;
        }
        try {
            const res = await fetch(`${this.base()}/api/symposium/relay/register`, {
                method: "POST",
                headers: { ...(await this.headers()), "content-type": "application/json" },
                body: JSON.stringify({ machineId }),
            });
            if (!res.ok) {
                return null;
            }
            return (await res.json()) as RelayRegisterResult;
        } catch {
            return null;
        }
    }
}
