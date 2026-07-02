import type { OpenAITool } from "./defs";

/**
 * Local workspace tools (shell + filesystem) — parity with what the Claude
 * Code / Copilot CLIs give their models. These run on the host in the session's
 * working directory, so an OpenAI-compatible backend ("Sufficit AI") can
 * actually DO work instead of only printing commands for the user to run.
 *
 * Kept in its own file (alongside subagentDefs) so defs.ts stays under the
 * per-file line cap. Re-exported via the aiTools index.
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
 * no nested "function" wrapper). Exported so defs.ts can reuse it for the other
 * tool families (kept DRY across the split files).
 */
export const toResponsesShape = (t: OpenAITool) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
});

/** Local tools in the Responses API (flat) shape. */
export const LOCAL_TOOLS_RESPONSES = LOCAL_TOOLS.map(toResponsesShape);
