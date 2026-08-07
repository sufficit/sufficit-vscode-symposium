import { clearSessionGuardrails, saveGuardrail } from "../../sync/guardrails";
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
    };
    try {
        return JSON.stringify(await ctx.hub.searchMemory(query));
    } catch (error) {
        warnFallback("searchMemory", error);
        return JSON.stringify({
            _notice:
                "SHARED MEMORY UNAVAILABLE: Using local fallback. Results are from local session storage only, not from shared cross-agent knowledge.",
            _memory_source: "local_fallback",
            records: await new LocalMemory().searchMemory(query),
        });
    }
}

async function getObservations(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    try {
        return JSON.stringify(await ctx.hub.getByIds(ids));
    } catch (error) {
        warnFallback("getByIds", error);
        return JSON.stringify({
            _notice:
                "SHARED MEMORY UNAVAILABLE: Using local fallback. Observations are from local session storage only, not from shared cross-agent knowledge.",
            _memory_source: "local_fallback",
            observations: await new LocalMemory().getByIds(ids),
        });
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
        warnFallback("save", error);
        const id = await new LocalMemory().save({ ...entry, type });
        return JSON.stringify({
            id,
            _notice:
                "SHARED MEMORY UNAVAILABLE: Saved to local fallback storage only. This observation is NOT available in shared cross-agent knowledge.",
            _memory_source: "local_fallback",
        });
    }
}

async function addGuardrail(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const text = String(args.text ?? "").trim();
    if (!text) return JSON.stringify({ error: "text is required" });
    if (!ctx.sessionId) return JSON.stringify({ error: "no current session" });
    try {
        if (!ctx.hub.configured()) throw new Error("memory hub not configured");
        const id = await saveGuardrail(ctx.hub, ctx.sessionId, text);
        return id ? JSON.stringify({ id }) : JSON.stringify({ error: "save failed" });
    } catch (error) {
        warnFallback("saveGuardrail", error);
        const id = await new LocalMemory().save({
            type: "guardrail",
            title: `Guardrail for session ${ctx.sessionId}`,
            summary: text,
            tags: `symposium-session:${ctx.sessionId},guardrail`,
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
