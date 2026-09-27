// Map backend tool names to the native-chat icon and action verb.
export const TOOL_META: Record<string, { icon: string; verb: string }> = {
    Read: { icon: "file", verb: "Read" },
    Write: { icon: "file", verb: "Wrote" },
    Edit: { icon: "edit", verb: "Edited" },
    MultiEdit: { icon: "edit", verb: "Edited" },
    NotebookEdit: { icon: "edit", verb: "Edited" },
    Bash: { icon: "terminal", verb: "Ran" },
    BashOutput: { icon: "terminal", verb: "Output" },
    exec: { icon: "terminal", verb: "Ran" },
    shell: { icon: "terminal", verb: "Ran" },
    read_file: { icon: "file", verb: "Read" },
    write_file: { icon: "file", verb: "Wrote" },
    list_dir: { icon: "file", verb: "Listed" },
    memory_search: { icon: "search", verb: "Memory" },
    memory_get_observations: { icon: "search", verb: "Memory" },
    memory_save: { icon: "file", verb: "Saved memory" },
    web_search: { icon: "globe", verb: "Searched web" },
    fetch_url: { icon: "globe", verb: "Fetched" },
    open_url: { icon: "globe", verb: "Opened" },
    read_session: { icon: "search", verb: "Read session" },
    Glob: { icon: "search", verb: "Searched" },
    Grep: { icon: "search", verb: "Searched" },
    LS: { icon: "file", verb: "Listed" },
    Task: { icon: "robot", verb: "Task" },
    WebFetch: { icon: "globe", verb: "Fetched" },
    WebSearch: { icon: "globe", verb: "Searched web" },
    TodoWrite: { icon: "list", verb: "Updated plan" },
};

/** Never present Codex's opaque web-search marker as if it were a query. */
export function normalizeToolDisplay(
    name: string,
    detail: string,
    input: string | undefined,
): { detail: string; input: string | undefined } {
    if (name !== "web_search") return { detail, input };
    const normalizedDetail =
        !detail || detail === "Tool call" ? "Search terms not available in this record" : detail;
    if (!input) return { detail: normalizedDetail, input };
    try {
        const action = JSON.parse(input) as Record<string, unknown>;
        if (
            action &&
            !Array.isArray(action) &&
            Object.keys(action).length === 1 &&
            action.type === "other"
        ) {
            return { detail: normalizedDetail, input: undefined };
        }
    } catch {
        // Non-JSON input may contain useful provider details; preserve it.
    }
    return { detail: normalizedDetail, input };
}
