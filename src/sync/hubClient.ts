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
}

export interface Observation {
    id?: string;
    type: string;
    title: string;
    summary: string;
    payload?: string;
    tags?: string;
    /** ISO-8601 expiry; set in the past to soft-delete on the next save (upsert). */
    expiresAtUtc?: string;
}

export interface SaveResponse {
    success: boolean;
    data?: { id: string; createdAtUtc: string };
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

export class HubClient {
    private base(): string {
        return vscode.workspace.getConfiguration("symposium.hub").get<string>("url", "").replace(/\/+$/, "");
    }

    private token(): string {
        return vscode.workspace.getConfiguration("symposium.hub").get<string>("token", "");
    }

    private contextId(): string {
        return vscode.workspace.getConfiguration("symposium.hub").get<string>("contextId", "");
    }

    private source(): string {
        return vscode.workspace.getConfiguration("symposium.hub").get<string>("source", "symposium");
    }

    /** True when a hub URL is configured. */
    configured(): boolean {
        return this.base().length > 0;
    }

    private async headers(): Promise<Record<string, string>> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            "Accept": "application/json",
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
            const res = await fetch(`${this.base()}/api/memory/health`, { headers: await this.headers() });
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
    async searchMemory(params: { query?: string; type?: string; limit?: number }): Promise<CompactRecord[]> {
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
}
