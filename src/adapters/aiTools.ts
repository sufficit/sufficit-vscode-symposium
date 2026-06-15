import { HubClient } from "../sync/hubClient";

/**
 * Sufficit memory + web tools exposed to OpenAI-compatible models as function
 * tools. The model calls them; the OpenAI adapter executes each against the
 * sufficit-ai REST hub (memory) / gateway (web) and feeds the result back.
 *
 * This is the bridge that gives the native "Sufficit AI" backend the same
 * memory/search capability the CLI backends get from the MCP server.
 */

export interface OpenAITool {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const AI_TOOLS: OpenAITool[] = [
    {
        type: "function",
        function: {
            name: "memory_search",
            description: "Search the shared Sufficit AI memory (cross-agent knowledge: facts, guidelines, task history, agent defs). Returns compact records (id, title, summary). Use before non-trivial tasks and to recall prior context.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Free-text query matched against title and summary." },
                    type: { type: "string", description: "Optional type filter, e.g. guideline, fact, task-checkpoint, agent-def." },
                    limit: { type: "integer", description: "Max records (1-50). Default 20." },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "memory_get_observations",
            description: "Fetch full memory observations (including payload) by their ids, after a memory_search returned promising ids.",
            parameters: {
                type: "object",
                properties: { ids: { type: "array", items: { type: "string" }, description: "Observation ids." } },
                required: ["ids"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "memory_save",
            description: "Persist a memory observation to shared Sufficit memory (e.g. a durable fact, decision, or task-checkpoint). Never store secrets.",
            parameters: {
                type: "object",
                properties: {
                    type: { type: "string", description: "Observation type, e.g. fact, decision, task-checkpoint, note." },
                    title: { type: "string", description: "Short title." },
                    summary: { type: "string", description: "Compact searchable text." },
                    payload: { type: "string", description: "Optional full detail (JSON or text)." },
                    tags: { type: "string", description: "Optional comma-separated tags." },
                },
                required: ["type", "title", "summary"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the public web via the Sufficit gateway. Returns results with titles, urls and snippets.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The search query." },
                    limit: { type: "integer", description: "Max results (1-15). Default 8." },
                },
                required: ["query"],
            },
        },
    },
];

/** Executes one tool call against the hub. Returns a JSON string for the model. */
export async function runAiTool(name: string, args: Record<string, unknown>, hub: HubClient): Promise<string> {
    try {
        switch (name) {
            case "memory_search": {
                const recs = await hub.searchMemory({
                    query: String(args.query ?? ""),
                    type: args.type ? String(args.type) : undefined,
                    limit: typeof args.limit === "number" ? args.limit : undefined,
                });
                return JSON.stringify(recs);
            }
            case "memory_get_observations": {
                const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
                return JSON.stringify(await hub.getByIds(ids));
            }
            case "memory_save": {
                const id = await hub.save({
                    type: String(args.type ?? "note"),
                    title: String(args.title ?? ""),
                    summary: String(args.summary ?? ""),
                    payload: args.payload ? String(args.payload) : undefined,
                    tags: args.tags ? String(args.tags) : undefined,
                });
                return JSON.stringify({ id });
            }
            case "web_search": {
                const r = await hub.webSearch(String(args.query ?? ""), typeof args.limit === "number" ? args.limit : 8);
                return JSON.stringify(r).slice(0, 12000);
            }
            default:
                return JSON.stringify({ error: `unknown tool ${name}` });
        }
    } catch (err) {
        return JSON.stringify({ error: String(err) });
    }
}
