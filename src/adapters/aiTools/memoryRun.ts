import {
    clearSessionGuardrails,
    MAX_GUARDRAIL_TEXT_LENGTH,
    saveGuardrail,
} from "../../sync/guardrails";
import { LocalMemory } from "./localMemory";
import type { ToolContext } from "./types";

const NAMES = new Set([
    "memory_search",
    "memory_get_observations",
    "memory_save",
    "add_guardrail",
    "clear_guardrails",
    "web_search",
]);

export async function runMemoryTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
): Promise<string | undefined> {
    if (!NAMES.has(name)) return undefined;
    if (name === "memory_search") return search(args, ctx);
    if (name === "memory_get_observations") return getObservations(args, ctx);
    if (name === "memory_save") return save(args, ctx);
    if (name === "add_guardrail") return addGuardrail(args, ctx);
    if (name === "clear_guardrails") return clearGuardrails(ctx);
    const result = await ctx.hub.webSearch(
        String(args.query ?? ""),
        typeof args.limit === "number" ? args.limit : 8,
    );
    return JSON.stringify(result).slice(0, 12000);
}

async function search(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const query = {
        query: String(args.query ?? ""),
        type: args.type ? String(args.type) : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        strategy: memorySearchStrategy(args.strategy),
        maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : 1_600,
        diversityLambda: typeof args.diversityLambda === "number" ? args.diversityLambda : 0.65,
    };
    try {
        return JSON.stringify(await ctx.hub.searchMemory(query, ctx.sessionId));
    } catch (error) {
        return remoteMemoryError("searchMemory", error);
    }
}

async function getObservations(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    try {
        return JSON.stringify(await ctx.hub.getByIds(ids, ctx.sessionId));
    } catch (error) {
        return remoteMemoryError("getByIds", error);
    }
}

async function save(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const type = String(args.type ?? "note");
    const tags = args.tags ? String(args.tags) : "";
    const allowedTaskTypes = new Set(["task-anchor", "task-checkpoint"]);
    const effectiveType = type.startsWith("task") && !allowedTaskTypes.has(type) ? "note" : type;
    const sessionScoped = !!ctx.sessionId && effectiveType.startsWith("task");
    const entry = {
        type: effectiveType,
        title: String(args.title ?? ""),
        summary: String(args.summary ?? ""),
        payload: args.payload ? String(args.payload) : undefined,
        tags: tags || undefined,
    };
    try {
        const id = await ctx.hub.save({
            ...entry,
            sessionId: sessionScoped ? ctx.sessionId : undefined,
            privacyLevel: sessionScoped ? ("internal" as const) : undefined,
        });
        return JSON.stringify({ id });
    } catch (error) {
        return remoteMemoryError("save", error);
    }
}

async function addGuardrail(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const text = String(args.text ?? "").trim();
    if (!text) return JSON.stringify({ error: "text is required" });
    if (text.length > MAX_GUARDRAIL_TEXT_LENGTH) {
        return JSON.stringify({ error: `text exceeds ${MAX_GUARDRAIL_TEXT_LENGTH} characters` });
    }
    if (!ctx.sessionId) return JSON.stringify({ error: "no current session" });
    const origin =
        args.origin === "user-approved" || args.origin === "agent-requested"
            ? args.origin
            : "agent-requested";
    const expiresAtUtc =
        typeof args.expiresAtUtc === "string" && args.expiresAtUtc.trim()
            ? args.expiresAtUtc.trim()
            : undefined;
    if (expiresAtUtc) {
        const expiry = Date.parse(expiresAtUtc);
        if (!Number.isFinite(expiry) || expiry <= Date.now()) {
            return JSON.stringify({ error: "expiresAtUtc must be a valid future timestamp" });
        }
    }
    try {
        if (!ctx.hub.configured()) throw new Error("memory hub not configured");
        const id = await saveGuardrail(ctx.hub, ctx.sessionId, text, { origin, expiresAtUtc });
        return id ? JSON.stringify({ id }) : JSON.stringify({ error: "save failed" });
    } catch (error) {
        warnFallback("saveGuardrail", error);
        const id = await new LocalMemory().save({
            type: "guardrail",
            title: `Guardrail for session ${ctx.sessionId}`,
            summary: text,
            tags: `symposium-session:${ctx.sessionId},guardrail,origin:${origin}`,
            expiresAtUtc,
        });
        return JSON.stringify({
            id: id.id,
            _notice:
                "SHARED MEMORY UNAVAILABLE: Guardrail saved to local fallback storage only. It will persist in this session but is NOT available in shared cross-agent knowledge.",
            _memory_source: "local_fallback",
        });
    }
}

async function clearGuardrails(ctx: ToolContext): Promise<string> {
    if (!ctx.sessionId) return JSON.stringify({ error: "no current session" });
    try {
        if (!ctx.hub.configured()) throw new Error("memory hub not configured");
        const removed = await clearSessionGuardrails(ctx.hub, ctx.sessionId);
        return removed >= 0 ? "" : JSON.stringify({ error: "clear failed" });
    } catch (error) {
        warnFallback("clearSessionGuardrails", error);
        const local = new LocalMemory();
        const all = await local.searchMemory({ query: "", type: "guardrail", limit: 100 });
        const matches = all.filter((item) =>
            item.tags?.includes(`symposium-session:${ctx.sessionId}`),
        );
        for (const item of matches) {
            if (item.id) {
                await local.save({
                    ...item,
                    expiresAtUtc: new Date(Date.now() - 86_400_000).toISOString(),
                });
            }
        }
        return JSON.stringify({
            removed: matches.length,
            _notice: `SHARED MEMORY UNAVAILABLE: Cleared ${matches.length} guardrail(s) from local fallback storage only. Shared cross-agent knowledge was not affected.`,
            _memory_source: "local_fallback",
        });
    }
}

function warnFallback(operation: string, error: unknown): void {
    console.warn(
        `[Symposium] Hub ${operation} failed, using local memory: ${error instanceof Error ? error.message : String(error)}`,
    );
}

function remoteMemoryError(operation: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Symposium] Hub ${operation} failed: ${message}`);
    return JSON.stringify({
        error: `Sufficit AI memory ${operation} failed: ${message}`,
        retryable: true,
        _memory_source: "remote_unavailable",
        _notice:
            "Canonical Sufficit AI memory is unavailable. No local fallback was read or written.",
    });
}

function memorySearchStrategy(value: unknown): "Exact" | "Semantic" | "Hybrid" {
    return value === "Exact" || value === "Semantic" || value === "Hybrid" ? value : "Hybrid";
}
