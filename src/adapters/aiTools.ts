import { HubClient } from "../sync/hubClient";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
            description: "Run a shell command on the host, in the session's working directory, and return its combined stdout+stderr and exit code. Use for builds, tests, git, file inspection, system diagnostics — anything you would otherwise ask the user to paste into a terminal. Non-interactive only.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The command line to execute (run via bash -lc)." },
                    cwd: { type: "string", description: "Optional working directory (absolute, or relative to the session cwd). Defaults to the session cwd." },
                    timeout_ms: { type: "integer", description: "Optional timeout in milliseconds (default 120000, max 600000)." },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read a UTF-8 text file from the host and return its contents.",
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
            description: "Write (create or overwrite) a UTF-8 text file on the host. Creates parent directories as needed.",
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
    const names: string[] = [];
    if (has(/^sufficit-ai\b|^sufficit-ai\/|^memory\b/i)) {
        names.push("memory_search", "memory_get_observations", "memory_save");
    }
    if (has(/^web\b|^search\b|^web_search\b/i)) {
        names.push("web_search");
    }
    // Shell/filesystem parity tools, enabled by a shell/exec/bash/fs capability.
    if (has(/^shell\b|^exec\b|^bash\b|^terminal\b|^fs\b|^filesystem\b/i)) {
        names.push(...LOCAL_TOOL_NAMES);
    }
    return names;
}

/** Filters tool definitions to an allowlist of names (undefined = all). */
export function filterTools<T extends { function?: { name: string }; name?: string }>(tools: T[], allow?: string[]): T[] {
    if (!allow) {
        return tools;
    }
    const set = new Set(allow);
    return tools.filter((t) => set.has((t.function?.name ?? t.name) as string));
}

export interface ToolContext {
    hub: HubClient;
    /** Session working directory — base for shell/fs tools and relative paths. */
    cwd: string;
    /** Permission mode; "plan" forbids mutating/executing tools (read-only). */
    permission?: string;
    /** Symposium chat session id — tasks saved to memory are bound to it. */
    sessionId?: string;
}

/** Resolves a tool path against the session cwd (absolute paths pass through). */
function resolvePath(cwd: string, p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** Runs a shell command, capturing combined output. Never throws. */
function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
        const child = execFile("bash", ["-lc", command], {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: process.env,
        }, (err, stdout, stderr) => {
            const out = (String(stdout || "") + String(stderr || "")).slice(0, 30000);
            const code = err && typeof (err as any).code === "number" ? (err as any).code : (err ? 1 : 0);
            resolve({ stdout: out || (err ? String(err.message) : ""), code });
        });
        void child;
    });
}

/** Executes one tool call. Returns a JSON string for the model. */
export async function runAiTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const hub = ctx.hub;
    const planMode = ctx.permission === "plan";
    try {
        // ---- local workspace tools (shell / filesystem) ----
        if (name === "shell") {
            if (planMode) { return JSON.stringify({ error: "plan mode: command execution is disabled" }); }
            const command = String(args.command ?? "").trim();
            if (!command) { return JSON.stringify({ error: "empty command" }); }
            const cwd = args.cwd ? resolvePath(ctx.cwd, String(args.cwd)) : ctx.cwd;
            const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 600000);
            const { stdout, code } = await runShell(command, cwd, timeout);
            return JSON.stringify({ exit_code: code, output: stdout });
        }
        if (name === "read_file") {
            const p = resolvePath(ctx.cwd, String(args.path ?? ""));
            const max = Number(args.max_bytes) || 100000;
            const data = fs.readFileSync(p, "utf8");
            return JSON.stringify({ path: p, content: data.slice(0, max), truncated: data.length > max });
        }
        if (name === "write_file") {
            if (planMode) { return JSON.stringify({ error: "plan mode: writing files is disabled" }); }
            const p = resolvePath(ctx.cwd, String(args.path ?? ""));
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, String(args.content ?? ""), "utf8");
            return JSON.stringify({ path: p, bytes: Buffer.byteLength(String(args.content ?? "")) });
        }
        if (name === "list_dir") {
            const p = args.path ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
            const entries = fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
            return JSON.stringify({ path: p, entries });
        }
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
                // Bind task observations to the current Symposium chat session so
                // they can be listed in the Tasks panel and removed with it.
                let tags = args.tags ? String(args.tags) : "";
                const type = String(args.type ?? "note");
                if (ctx.sessionId && type.startsWith("task")) {
                    const tag = `symposium-session:${ctx.sessionId}`;
                    if (!tags.split(",").map((t) => t.trim()).includes(tag)) {
                        tags = tags ? `${tags},${tag}` : tag;
                    }
                }
                const id = await hub.save({
                    type,
                    title: String(args.title ?? ""),
                    summary: String(args.summary ?? ""),
                    payload: args.payload ? String(args.payload) : undefined,
                    tags: tags || undefined,
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
