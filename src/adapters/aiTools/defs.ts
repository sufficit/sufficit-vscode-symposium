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
            name: "add_task",
            description: "Create one or more session tasks (a plan), shown in the Tasks panel. Use this the MOMENT the user approves a multi-step plan you proposed: record EACH step as a task BEFORE you start acting, so the plan is tracked and you can mark each task_complete as you finish. Also use it whenever you commit to a new multi-step piece of work.",
            parameters: {
                type: "object",
                properties: {
                    tasks: { type: "array", items: { type: "string" }, description: "One short title per step/task, in order." },
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
            description: "Mark a session task (by its memory id) as completed. It then drops out of the pending Tasks list. Use when you finish the work a task-checkpoint described.",
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
 * Local workspace tools (shell + filesystem) — the parity with what the Claude
 * Code / Copilot CLIs give their models. These run on the host in the session's
 * working directory, so an OpenAI-compatible backend ("Sufficit AI") can
 * actually DO work instead of only printing commands for the user to run.
 */
export const LOCAL_TOOLS: OpenAITool[] = [
    {
        type: "function",
        function: {
            name: "shell",
            description: "Run a shell command on the host, in the session's working directory, and return its combined stdout+stderr and exit code. Use for builds, tests, git, file inspection, system diagnostics — anything you would otherwise ask the user to paste into a terminal. Non-interactive only. Do NOT use the shell to create or modify files (sed/awk/perl/tee/echo >, heredocs): those edits are opaque and not revertable. Use edit_file (surgical) or write_file (whole file) instead — they are tracked and show in the changed-files panel.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The command line to execute (run via bash -lc)." },
                    description: { type: "string", description: "A short human-readable description (5-10 words) of what this command does, shown to the user so they understand the step." },
                    cwd: { type: "string", description: "Optional working directory (absolute, or relative to the session cwd). Defaults to the session cwd." },
                    timeout_ms: { type: "integer", description: "Timeout in milliseconds. Default 30000 (30s). Pass 0 for UNLIMITED — only for long-running services (dev servers, watchers, tail -f) you intend to keep running; otherwise always bounded." },
                    terminal_id: { type: "string", description: "Optional id of a previously returned visible terminal to reuse/continue. Only applies when shell execution display mode is terminal; ignored in silent/inline modes." },
                    notify: { type: "boolean", description: "Set true when the command's output is relevant and you want to be notified of the result as soon as it completes (the output is surfaced back to you). Use for builds/tests/diagnostics whose result you must see." },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read a file from the host. Text files return their UTF-8 contents. Binary files are detected and NOT dumped as garbage: an image returns a base64 data URI (for a vision-capable model/preset) plus a note; other binaries return a size note. Raise max_bytes to inline a larger image.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "File path (absolute, or relative to the session cwd)." },
                    max_bytes: { type: "integer", description: "Optional cap on bytes returned (default 100000)." },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Create a NEW file, or fully overwrite a file, with the given UTF-8 content. Creates parent directories as needed. PREFER this (and edit_file) over shell redirection/sed/awk/tee to write files: these tools are tracked — the edit shows in the changed-files panel and can be reverted. Use edit_file for a surgical change to an existing file; use write_file when you are authoring the whole file.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "File path (absolute, or relative to the session cwd)." },
                    content: { type: "string", description: "Full file content to write." },
                },
                required: ["path", "content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "Apply a surgical edit to an existing text file by replacing an exact string. PREFER this over shell sed/awk/perl for editing files: it is tracked (shows a diff in the changed-files panel and can be reverted), whereas shell edits are opaque and not revertable. `old_string` must match the file content exactly (including whitespace/indentation) and be unique — include enough surrounding context to disambiguate, or set replace_all to change every occurrence.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "File path (absolute, or relative to the session cwd)." },
                    old_string: { type: "string", description: "The exact text to find (must be unique unless replace_all is true)." },
                    new_string: { type: "string", description: "The replacement text." },
                    replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match. Default false." },
                },
                required: ["path", "old_string", "new_string"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_dir",
            description: "List entries of a directory on the host (names + whether each is a directory).",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Directory path (absolute, or relative to the session cwd). Defaults to the session cwd." },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_url",
            description: "Fetch a web page (HTTP GET) and return its readable text content (HTML stripped). Use to read documentation, release notes, install instructions — anything you'd open in a browser. Navigate by fetching successive URLs (e.g. links found in the page).",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "Absolute URL (http/https)." },
                    max_chars: { type: "integer", description: "Optional cap on characters returned (default 30000)." },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "open_url",
            description: "Open a URL in the VS Code built-in Simple Browser so the user can see the page on screen. Use alongside fetch_url when the user should watch/inspect the site.",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "Absolute URL (http/https) to display." } },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_session",
            description: "Read the full conversation transcript of a Symposium chat session by its GUID. Omit `id` to read the CURRENT session (always available — see the [session: <guid>] note in your context). Use this to recover earlier context that may have been compacted/summarized out of your working memory. The transcript is read losslessly from the session ledger when available.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Session GUID. Omit to read the current session." },
                    tail: { type: "integer", description: "Return only the last N messages (default: all)." },
                    max_chars: { type: "integer", description: "Cap on characters returned (default 24000)." },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_workspace_bootstrap",
            description: "Read THIS workspace's session bootstrap — the standing context (markdown) that Symposium injects once at the start of every NEW session opened in this workspace folder. Returns the current text (empty if none set). This is NOT shared memory; it is a per-workspace file resolved from the folder name.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "set_workspace_bootstrap",
            description: "Set (replace) THIS workspace's session bootstrap: the standing context injected once at the start of every NEW session opened in this workspace folder — e.g. a project's copilot-instructions / conventions. Use when the user asks to 'add X as the session/workspace bootstrap'. Persists to ~/.symposium/repo/bootstrap/<workspace>.md; the user can open it from the new-session screen. NOT the shared Sufficit memory.",
            parameters: {
                type: "object",
                properties: { text: { type: "string", description: "Full bootstrap content (markdown). Replaces any existing bootstrap for this workspace." } },
                required: ["text"],
            },
        },
    },
];

/** Names of the local workspace tools (shell/fs). */
export const LOCAL_TOOL_NAMES = LOCAL_TOOLS.map((t) => t.function.name);

/**
 * Same tools in the Responses API shape (flat: type/name/description/parameters,
 * no nested "function" wrapper).
 */
const toResponsesShape = (t: OpenAITool) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
});
export const AI_TOOLS_RESPONSES = AI_TOOLS.map(toResponsesShape);
export const LOCAL_TOOLS_RESPONSES = LOCAL_TOOLS.map(toResponsesShape);

/** All AI tool names this bridge can expose. */
export const ALL_AI_TOOL_NAMES = [...AI_TOOLS, ...LOCAL_TOOLS].map((t) => t.function.name);

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
    names.add("add_task"); names.add("list_tasks"); names.add("task_complete");
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
    return [...names];
}

/** Filters tool definitions to an allowlist of names (undefined = all). */
export function filterTools<T extends { function?: { name: string }; name?: string }>(tools: T[], allow?: string[]): T[] {
    if (!allow) {
        return tools;
    }
    const set = new Set(allow);
    return tools.filter((t) => set.has((t.function?.name ?? t.name) as string));
}
