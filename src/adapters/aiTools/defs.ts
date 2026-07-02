/**
 * Sufficit memory + web tools exposed to OpenAI-compatible models as function
 * tools. The model calls them; the OpenAI adapter executes each against the
 * sufficit-ai REST hub (memory) / gateway (web) and feeds the result back.
 *
 * This is the bridge that gives the native "Sufficit AI" backend the same
 * memory/search capability the CLI backends get from the MCP server.
 *
 * IMPORTANT: Tools are split into two categories:
 * - UNIVERSAL_TOOLS: Work with ANY backend (have local fallbacks when hub unavailable)
 * - HUB_TOOLS: Require the sufficit-ai hub to function correctly
 */

// Subagent tool defs live in their own file (keeps defs.ts under the line cap);
// re-exported via the aiTools index so callers import them from one place.
import { SUBAGENT_TOOLS, SUBAGENT_TOOL_NAMES } from "./subagentDefs";
// Local workspace tools (shell/fs) live in their own file for the same reason;
// LOCAL_TOOLS / LOCAL_TOOL_NAMES / LOCAL_TOOLS_RESPONSES are imported back here,
// and toResponsesShape is shared from localDefs so the shape mapping stays DRY.
import { LOCAL_TOOLS, LOCAL_TOOL_NAMES, toResponsesShape } from "./localDefs";

export interface OpenAITool {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
}

// Universal tools: work with any backend via local fallbacks
const UNIVERSAL_MEMORY_TOOLS: OpenAITool[] = [
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
            name: "add_guardrail",
            description: "Add an absolute rule (guardrail) for THIS chat session — a hard constraint you must honor on every message for the rest of the session (e.g. 'only edit the backend, never the Razor markup'). Use it to lock in a constraint the user gave you, or a commitment you make, so it can't drift across turns. Guardrails are injected into every later message. Keep each one short and imperative.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The rule, short and imperative (one sentence)." },
                },
                required: ["text"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "clear_guardrails",
            description: "Remove ALL guardrails for THIS chat session (when the user asks to clear/remove the guardrails). Returns how many were removed. After this, no guardrails are injected until new ones are added.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
];

/**
 * Hub-only tools: require the sufficit-ai hub to function correctly (no local
 * fallback). Session task tools (add_task/list_tasks/task_complete) and web
 * search route straight through hub.* and hard-fail when it isn't configured.
 */
const HUB_TOOLS: OpenAITool[] = [
    {
        type: "function",
        function: {
            name: "add_task",
            description: "Create one or more session tasks (a plan), shown in the Tasks panel. Use this the MOMENT the user approves a multi-step plan you proposed: record EACH step as a task BEFORE you start acting, so the plan is tracked and you can mark each task_complete as you finish. Use it whenever you commit to a new multi-step piece of work.",
            parameters: {
                type: "object",
                properties: {
                    tasks: { type: "array", items: { type: "string" }, description: "One short title per step/task, in order." },
                    user_requested: { type: "boolean", description: "Set true when user explicitly requested this task. Default false (agent-created). User-requested tasks require user confirmation before completion." },
                },
                required: ["tasks"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "TaskCreate",
            description: "Create one or more session tasks (a plan), shown in the Tasks panel. Alias for add_task, compatible with Claude Code naming. Use this the MOMENT the user approves a multi-step plan you proposed: record EACH step as a task BEFORE you start acting, so the plan is tracked and you can mark TaskUpdate(done=true) as you finish.",
            parameters: {
                type: "object",
                properties: {
                    tasks: { type: "array", items: { type: "string" }, description: "One short title per step/task, in order." },
                    user_requested: { type: "boolean", description: "Set true when user explicitly requested this task. Default false (agent-created). User-requested tasks require user confirmation before completion." },
                },
                required: ["tasks"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_tasks",
            description: "List this chat session's tasks (task-anchor / task-checkpoint memory items bound to the session). Returns PENDING tasks by default; pass all=true to include completed ones too.",
            parameters: {
                type: "object",
                properties: {
                    all: { type: "boolean", description: "Include completed tasks as well. Default false (pending only)." },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "task_complete",
            description: "Mark a session task (by its memory id) as completed. WORKFLOW: (1) Agent-created tasks (default): call IMMEDIATELY after finishing - don't wait. (2) User-requested tasks: present justification why task is complete and WAIT for user confirmation before calling this. The task drops from pending Tasks panel.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "The task observation id (from list_tasks / memory)." },
                },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "TaskUpdate",
            description: "Mark a session task as completed. Alias for task_complete, compatible with Claude Code naming. Pass the task id and done=true.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "The task observation id (from TaskCreate / list_tasks / memory)." },
                    done: { type: "boolean", description: "Set true to mark as completed. Default true." },
                },
                required: ["id"],
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

/**
 * All memory/web tools exposed to OpenAI-compatible models: the universal set
 * (works with any backend via local fallback) plus the hub-only set. This is
 * the canonical contract consumed by the OpenAI adapter (turnRunner/session);
 * when the hub is not configured, the adapter still offers the universal subset
 * and silently degrades for the hub-only ones at execution time.
 */
export const AI_TOOLS: OpenAITool[] = [...UNIVERSAL_MEMORY_TOOLS, ...HUB_TOOLS];

/** Responses-API (flat) shape for the memory/web tools. */
export const AI_TOOLS_RESPONSES = AI_TOOLS.map(toResponsesShape);

/** All AI tool names this bridge can expose. */
export const ALL_AI_TOOL_NAMES = [...AI_TOOLS, ...LOCAL_TOOLS, ...SUBAGENT_TOOLS].map((t) => t.function.name);

/**
 * Maps an agent-def's declared capability tokens to the concrete AI tool names
 * to expose. Memory tools require a `sufficit-ai/*` (or `memory`) capability;
 * `web`/`search`/`web_search` enable web search. Returns null when the agent
 * declares no relevant capability — meaning "expose nothing" (gated off).
 */
export function aiToolsForAgent(declared: string[]): string[] {
    const has = (re: RegExp) => declared.some((d) => re.test(d));
    const names = new Set<string>();
    // Always available: re-reading the conversation by GUID is a safe, read-only
    // recall primitive (no side effects). Every agent gets it so it can recover
    // earlier/compacted context when the user says "reread the history".
    names.add("read_session");
    // Session task tools are always safe (scoped to this session, no secrets).
    names.add("add_task"); names.add("TaskCreate"); names.add("list_tasks"); names.add("task_complete"); names.add("TaskUpdate");
    // Guardrails are session-scoped self-constraints: always available so any
    // agent can lock in a hard rule the user gave it (the user can still remove).
    names.add("add_guardrail"); names.add("clear_guardrails");
    // Workspace bootstrap is a per-folder config file (read/replace), always safe.
    names.add("get_workspace_bootstrap"); names.add("set_workspace_bootstrap");
    if (has(/^sufficit-ai\b|^sufficit-ai\/|^memory\b/i)) {
        names.add("memory_search"); names.add("memory_get_observations"); names.add("memory_save");
    }
    if (has(/^web\b|^search\b|^web_search\b|^browse\b|^fetch\b/i)) {
        names.add("web_search"); names.add("fetch_url"); names.add("open_url");
    }
    // Full shell/filesystem parity, enabled by a shell/exec/bash/terminal capability.
    if (has(/^shell\b|^exec\b|^bash\b|^terminal\b/i)) {
        for (const n of LOCAL_TOOL_NAMES) { names.add(n); }
    }
    // Granular file access: read/write/edit/fs/filesystem give the file tools
    // (read_file/write_file/list_dir) WITHOUT exposing the shell — so an agent
    // can author files/plans for you without arbitrary command execution.
    if (has(/^fs\b|^filesystem\b/i)) {
        names.add("read_file"); names.add("write_file"); names.add("edit_file"); names.add("list_dir");
    }
    if (has(/^read\b|^read_file\b/i)) { names.add("read_file"); names.add("list_dir"); }
    if (has(/^write\b|^write_file\b|^edit\b|^edit_file\b/i)) {
        names.add("write_file"); names.add("edit_file"); names.add("read_file"); names.add("list_dir");
    }
    if (has(/^list\b|^list_dir\b|^ls\b/i)) { names.add("list_dir"); }
    // Subagent orchestration: an agent that declares agents/spawn/orchestrate may
    // itself delegate to other agent-defs (bounded by depth/concurrency guards).
    if (has(/^agents?\b|^spawn\b|^orchestrate\b|^subagents?\b|^delegate\b/i)) {
        for (const n of SUBAGENT_TOOL_NAMES) { names.add(n); }
    }
    return [...names];
}

/** Filters tool definitions to an allowlist of names (undefined = all). */
export function filterTools<T extends { function?: { name: string; description?: string }; name?: string; description?: string }>(tools: T[], allow?: string[]): T[] {
    if (!allow) {
        return tools;
    }
    const set = new Set(allow);
    return tools.filter((t) => set.has((t.function?.name ?? t.name) as string));
}
