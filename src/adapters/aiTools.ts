import { HubClient } from "../sync/hubClient";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { readSession, dumpToText } from "../sessionReader";

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
        names.add("read_file"); names.add("write_file"); names.add("list_dir");
    }
    if (has(/^read\b|^read_file\b/i)) { names.add("read_file"); names.add("list_dir"); }
    if (has(/^write\b|^write_file\b|^edit\b|^edit_file\b/i)) {
        names.add("write_file"); names.add("read_file"); names.add("list_dir");
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

export type ShellExecutionMode = "silent" | "inline" | "terminal";

export interface ToolProgressSink {
    onData?(chunk: string): void;
    onTerminal?(terminalName: string): void;
    /** Model flagged this command's result as relevant — surface it to the user. */
    onNotify?(message: string): void;
}

export interface ToolContext {
    hub: HubClient;
    /** Session working directory — base for shell/fs tools and relative paths. */
    cwd: string;
    /** Permission mode; "plan" forbids mutating/executing tools (read-only). */
    permission?: string;
    /** Symposium chat session id — tasks saved to memory are bound to it. */
    sessionId?: string;
    /** How shell commands should be surfaced to the user. */
    shellExecution?: ShellExecutionMode;
    /** Live progress callbacks (stream output, terminal opened). */
    progress?: ToolProgressSink;
}

/** Resolves a tool path against the session cwd (absolute paths pass through). */
function resolvePath(cwd: string, p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}


function firstShellWord(command: string): string {
    const trimmed = command.trim();
    if (!trimmed) { return ""; }
    const m = trimmed.match(/^([A-Za-z0-9_./-]+)/);
    return m ? path.basename(m[1]) : "";
}

async function commandExists(cmd: string, cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1`], { cwd, env: process.env }, (err) => resolve(!err));
    });
}

async function canUseRtk(command: string, cwd: string): Promise<boolean> {
    const c = command.trim();
    if (!c || c.startsWith("rtk ")) { return false; }
    // Avoid changing semantics for compound/interactive shell snippets. The
    // policy prompt tells the model to use rtk explicitly for these when safe.
    if (/\n|\||&&|\|\||;|<<|>|<|\$\(|`/.test(c)) { return false; }
    const word = firstShellWord(c);
    const supported = new Set([
        "git", "gh", "ls", "find", "rg", "grep", "cat", "head", "tail",
        "npm", "pnpm", "yarn", "bun", "vitest", "jest", "pytest", "go",
        "cargo", "tsc", "eslint", "biome", "prettier", "ruff", "golangci-lint",
        "docker", "kubectl", "curl", "wget",
    ]);
    if (!supported.has(word)) { return false; }
    return commandExists("rtk", cwd);
}

/** Runs a shell command, capturing combined output. Never throws. */
function runShell(command: string, cwd: string, timeoutMs: number, progress?: ToolProgressSink): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
        const child = spawn("bash", ["-lc", command], { cwd, env: process.env });
        let out = "";
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                out += `\n[Symposium] command timed out after ${timeoutMs}ms; terminating...\n`;
                try { child.kill("SIGTERM"); } catch { /* ignore */ }
            }
        }, timeoutMs);
        const push = (chunk: Buffer | string) => {
            const text = String(chunk);
            out += text;
            if (out.length > 120000) { out = out.slice(out.length - 120000); }
            progress?.onData?.(text);
        };
        child.stdout?.on("data", push);
        child.stderr?.on("data", push);
        child.on("error", (err) => { push(String(err.message)); });
        child.on("close", (code) => {
            done = true; clearTimeout(timer);
            resolve({ stdout: out.slice(0, 30000), code: typeof code === "number" ? code : 1 });
        });
    });
}

interface TerminalHandle {
    id: string;
    name: string;
    terminal: vscode.Terminal;
    cwd: string;
}

const TERMINALS = new Map<string, TerminalHandle>();
let terminalSeq = 0;

function terminalNameFor(id: string): string {
    return `symposium:${id}`;
}

function normalizeTerminalId(raw: unknown): string | undefined {
    const id = String(raw ?? "").trim();
    if (!id) { return undefined; }
    return id.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) || undefined;
}

function terminalHandleFor(requestedId: string | undefined, cwd: string): TerminalHandle {
    if (requestedId) {
        const existing = TERMINALS.get(requestedId);
        if (existing) {
            return existing;
        }
    }
    const id = requestedId || `t${++terminalSeq}-${randomUUID().slice(0, 8)}`;
    const name = terminalNameFor(id);
    const terminal = vscode.window.createTerminal({ name, cwd });
    const handle = { id, name, terminal, cwd };
    TERMINALS.set(id, handle);
    return handle;
}

function shellQuote(value: string): string {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function runShellInTerminal(command: string, cwd: string, timeoutMs: number, progress?: ToolProgressSink, terminalId?: string): Promise<{ stdout: string; code: number; terminal_id: string; reused: boolean }> {
    const existed = !!(terminalId && TERMINALS.has(terminalId));
    const handle = terminalHandleFor(terminalId, cwd);
    const name = handle.name;
    const term = handle.terminal;
    term.show(true);
    progress?.onTerminal?.(name);

    // Run the command ONCE in the visible terminal. We tee output to a temp file
    // so the model still gets the result, and capture the COMMAND'S OWN exit
    // code — not the tee's. Using a group with a trailing redirect (not process
    // substitution) avoids the spurious SIGPIPE/141 that `cmd > >(tee ...)`
    // introduces when the command's pipeline closes early (e.g. `... | head`).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-shell-"));
    const outFile = path.join(dir, "output.log");
    const codeFile = path.join(dir, "exit.code");
    fs.writeFileSync(outFile, "", "utf8");
    // Write the user command to a script file so quoting/heredocs/pipes are
    // preserved verbatim, then run it capturing its real exit status.
    const cmdFile = path.join(dir, "command.sh");
    fs.writeFileSync(cmdFile, command + "\n", "utf8");
    const wrapped =
        `{ bash ${shellQuote(cmdFile)}; printf '%s' "$?" > ${shellQuote(codeFile)}; } 2>&1 | tee -a ${shellQuote(outFile)}`;
    term.sendText(wrapped);

    const started = Date.now();
    let lastLen = 0;
    for (;;) {
        if (fs.existsSync(outFile)) {
            const data = fs.readFileSync(outFile, "utf8");
            if (data.length > lastLen) {
                // In terminal mode the user is already watching the visible
                // terminal; still forward chunks as tool output so the expanded
                // panel can mirror progress if open.
                progress?.onData?.(data.slice(lastLen));
                lastLen = data.length;
            }
        }
        if (fs.existsSync(codeFile)) {
            const data = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
            const raw = fs.readFileSync(codeFile, "utf8").trim();
            const code = /^\d+$/.test(raw) ? Number(raw) : 1;
            return { stdout: data.slice(0, 30000), code, terminal_id: handle.id, reused: existed };
        }
        if (Date.now() - started > timeoutMs) {
            term.sendText("\u0003");
            const data = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
            return { stdout: (data + `\n[Symposium] command timed out after ${timeoutMs}ms`).slice(0, 30000), code: 124, terminal_id: handle.id, reused: existed };
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

/** Strips HTML to readable text (drops script/style, tags → spaces). */
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t\f\r]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
}

/** Executes one tool call. Returns a JSON string for the model. */
export async function runAiTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const hub = ctx.hub;
    const planMode = ctx.permission === "plan";
    try {
        // ---- web navigation ----
        if (name === "fetch_url") {
            const url = String(args.url ?? "").trim();
            if (!/^https?:\/\//i.test(url)) { return JSON.stringify({ error: "url must start with http(s)://" }); }
            const max = Number(args.max_chars) || 30000;
            const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Symposium VS Code agent)" } });
            const ct = res.headers.get("content-type") || "";
            const raw = await res.text();
            const body = /html/i.test(ct) ? htmlToText(raw) : raw;
            return JSON.stringify({ url, status: res.status, content_type: ct, content: body.slice(0, max), truncated: body.length > max });
        }
        if (name === "open_url") {
            const url = String(args.url ?? "").trim();
            if (!/^https?:\/\//i.test(url)) { return JSON.stringify({ error: "url must start with http(s)://" }); }
            await vscode.commands.executeCommand("simpleBrowser.show", url);
            return JSON.stringify({ opened: url });
        }
        // ---- session memory (read-only, allowed in plan mode) ----
        if (name === "read_session") {
            const id = String(args.id ?? "").trim() || ctx.sessionId;
            if (!id) { return JSON.stringify({ error: "no session id (none provided and no current session)" }); }
            const dump = readSession(id);
            if (dump.source === "none") { return JSON.stringify({ error: `session ${id} not found on disk` }); }
            const tail = typeof args.tail === "number" ? args.tail : undefined;
            const maxChars = typeof args.max_chars === "number" ? args.max_chars : undefined;
            return dumpToText(dump, { tail, maxChars });
        }
        // ---- local workspace tools (shell / filesystem) ----
        if (name === "shell") {
            if (planMode) { return JSON.stringify({ error: "plan mode: command execution is disabled" }); }
            const command = String(args.command ?? "").trim();
            if (!command) { return JSON.stringify({ error: "empty command" }); }
            const cwd = args.cwd ? resolvePath(ctx.cwd, String(args.cwd)) : ctx.cwd;
            // Timeout: default 30s. 0 (or negative) means UNLIMITED — the model
            // must opt into that explicitly for long-running services. A bounded
            // value is clamped to [1s, 1h].
            const rawTimeout = args.timeout_ms === undefined ? 30000 : Number(args.timeout_ms);
            const unlimited = !(rawTimeout > 0);
            const timeout = unlimited ? Number.MAX_SAFE_INTEGER : Math.min(Math.max(rawTimeout, 1000), 3600000);
            const notify = args.notify === true;
            const mode = ctx.shellExecution ?? "silent";
            const terminalId = mode === "terminal" ? normalizeTerminalId(args.terminal_id) : undefined;
            const shouldUseRtk = mode === "silent" && await canUseRtk(command, cwd);
            const runCommand = shouldUseRtk ? `rtk ${command}` : command;
            const terminalRun = mode === "terminal"
                ? await runShellInTerminal(runCommand, cwd, timeout, ctx.progress, terminalId)
                : undefined;
            const { stdout, code } = terminalRun ?? await runShell(runCommand, cwd, timeout, mode === "inline" ? ctx.progress : undefined);
            // When the model flags the result as relevant, push it through the
            // progress sink as a steer-style notification so the chat surfaces it
            // even if the model wouldn't otherwise narrate the outcome.
            if (notify) {
                const head = stdout.split("\n").slice(0, 6).join("\n");
                ctx.progress?.onNotify?.(`shell exit ${code}${head ? `\n${head}` : ""}`);
            }
            return JSON.stringify({
                exit_code: code,
                output: stdout,
                display: mode,
                timed_out: code === 124,
                unlimited,
                terminal_id: terminalRun?.terminal_id,
                reused_terminal: terminalRun?.reused ?? false
            });
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
